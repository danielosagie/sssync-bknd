import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';
import { FuzzyMatcherService } from '../match/fuzzy-matcher.service';
import { ActivityLogService } from '../common/activity-log.service';

interface CsvMatchingJobData {
  userId: string;
  ingestJobId: string;
  batchSize?: number;
}

interface RawImportItem {
  Id: string;
  UserId: string;
  Source: string;
  RawRow: any;
  NormalizedSku?: string;
  NormalizedBarcode?: string;
  NormalizedTitle?: string;
  NormalizedPrice?: number;
  NormalizedQuantity?: number;
}

@Processor('csv-matching')
@Injectable()
export class CsvMatchingProcessor extends WorkerHost {
  private readonly logger = new Logger(CsvMatchingProcessor.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly fuzzyMatcherService: FuzzyMatcherService,
    private readonly activityLogService: ActivityLogService,
  ) {
    super();
  }

  async process(job: Job<CsvMatchingJobData>): Promise<{ processed: number; matched: number; ambiguous: number }> {
    const { userId, ingestJobId, batchSize = 100 } = job.data;
    const logPrefix = `[CSVMatch:${job.id}]`;

    this.logger.log(`${logPrefix} Starting CSV matching for ingestJobId: ${ingestJobId}, userId: ${userId}`);

    await job.updateProgress({ progress: 5, description: 'Fetching raw import items...' });

    // Get all raw items for this job
    const supabase = this.supabaseService.getClient();
    const { data: rawItems, error } = await supabase
      .from('RawImportItems')
      .select('*')
      .eq('UserId', userId)
      .eq('IngestJobId', ingestJobId);

    if (error) {
      this.logger.error(`${logPrefix} Failed to fetch raw items: ${error.message}`);
      throw new Error(`Failed to fetch raw import items: ${error.message}`);
    }

    if (!rawItems || rawItems.length === 0) {
      this.logger.warn(`${logPrefix} No raw items found for job ${ingestJobId}`);
      return { processed: 0, matched: 0, ambiguous: 0 };
    }

    await job.updateProgress({ progress: 10, description: `Processing ${rawItems.length} items...` });

    let processed = 0;
    let matched = 0;
    let ambiguous = 0;

    // Process in batches
    for (let i = 0; i < rawItems.length; i += batchSize) {
      const batch = rawItems.slice(i, i + batchSize);
      
      for (const rawItem of batch) {
        try {
          const result = await this.processRawItem(rawItem, userId);
          if (result.matched) matched++;
          if (result.ambiguous) ambiguous++;
          processed++;

          // Update progress
          const progressPercent = Math.min(90, 10 + (processed / rawItems.length) * 80);
          await job.updateProgress({ 
            progress: progressPercent, 
            description: `Processed ${processed}/${rawItems.length} items. Matched: ${matched}, Ambiguous: ${ambiguous}` 
          });

        } catch (error) {
          this.logger.error(`${logPrefix} Error processing raw item ${rawItem.Id}: ${error.message}`);
          // Continue processing other items
        }
      }
    }

    await job.updateProgress({ progress: 95, description: 'Finalizing results...' });

    // Log activity
    await this.activityLogService.logActivity({
      UserId: userId,
      EntityType: 'CSV_Import',
      EntityId: ingestJobId,
      EventType: 'CSV_MATCHING_COMPLETED',
      Status: 'Success',
      Message: `CSV matching completed for job ${ingestJobId}`,
      Details: { processed, matched, ambiguous, totalItems: rawItems.length }
    });

    await job.updateProgress({ progress: 100, description: 'CSV matching completed' });

    this.logger.log(`${logPrefix} Completed. Processed: ${processed}, Matched: ${matched}, Ambiguous: ${ambiguous}`);
    return { processed, matched, ambiguous };
  }

  private async processRawItem(rawItem: RawImportItem, userId: string): Promise<{ matched: boolean; ambiguous: boolean }> {
    const supabase = this.supabaseService.getClient();

    // Step 1: Deterministic matches (SKU, Barcode)
    if (rawItem.NormalizedSku) {
      const { data: skuMatch } = await supabase
        .from('ProductVariants')
        .select('Id, ProductId, Title, Sku')
        .eq('UserId', userId)
        .eq('Sku', rawItem.NormalizedSku)
        .maybeSingle();

      if (skuMatch) {
        await this.createMatchCandidate(rawItem, skuMatch, 'SKU', 1.0);
        return { matched: true, ambiguous: false };
      }
    }

    if (rawItem.NormalizedBarcode) {
      const { data: barcodeMatch } = await supabase
        .from('ProductVariants')
        .select('Id, ProductId, Title, Sku, Barcode')
        .eq('UserId', userId)
        .eq('Barcode', rawItem.NormalizedBarcode)
        .maybeSingle();

      if (barcodeMatch) {
        await this.createMatchCandidate(rawItem, barcodeMatch, 'BARCODE', 0.95);
        return { matched: true, ambiguous: false };
      }
    }

    // Step 2: Fuzzy title matching
    if (rawItem.NormalizedTitle) {
      const titleCandidates = await this.fuzzyMatcherService.findTitleCandidates(userId, rawItem.NormalizedTitle, 5);
      
      if (titleCandidates.length > 0) {
        const bestMatch = titleCandidates[0];
        
        // If best match is very high confidence (>0.8), consider it a match
        if (bestMatch.similarity > 0.8) {
          await this.createMatchCandidate(rawItem, {
            Id: bestMatch.variantId,
            Title: bestMatch.title,
            Sku: bestMatch.sku
          }, 'TITLE', bestMatch.similarity);
          return { matched: true, ambiguous: false };
        }

        // If we have decent candidates (>0.5), store them as ambiguous matches
        if (bestMatch.similarity > 0.5) {
          for (const candidate of titleCandidates.filter(c => c.similarity > 0.5)) {
            await this.createMatchCandidate(rawItem, {
              Id: candidate.variantId,
              Title: candidate.title,
              Sku: candidate.sku
            }, 'TITLE', candidate.similarity);
          }
          return { matched: false, ambiguous: true };
        }
      }
    }

    // No matches found - create a "NONE" candidate for manual review
    await this.createMatchCandidate(rawItem, null, 'NONE', 0.0);
    return { matched: false, ambiguous: false };
  }

  private async createMatchCandidate(
    rawItem: RawImportItem, 
    canonicalVariant: any | null, 
    matchType: string, 
    confidence: number
  ): Promise<void> {
    const supabase = this.supabaseService.getClient();

    const candidate = {
      RawImportItemId: rawItem.Id,
      UserId: rawItem.UserId,
      CanonicalVariantId: canonicalVariant?.Id || null,
      MatchType: matchType,
      Confidence: confidence,
      MatchData: {
        rawTitle: rawItem.NormalizedTitle,
        rawSku: rawItem.NormalizedSku,
        rawBarcode: rawItem.NormalizedBarcode,
        canonicalTitle: canonicalVariant?.Title || null,
        canonicalSku: canonicalVariant?.Sku || null,
      },
      Status: confidence > 0.8 ? 'AUTO_MATCHED' : confidence > 0.5 ? 'NEEDS_REVIEW' : 'NO_MATCH',
    };

    const { error } = await supabase.from('MatchCandidates').insert(candidate);
    if (error) {
      this.logger.error(`Failed to create match candidate: ${error.message}`);
    }
  }


}
