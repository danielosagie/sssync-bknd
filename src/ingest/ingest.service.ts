import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { SupabaseService } from '../common/supabase.service';
import Papa from 'papaparse';

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    @InjectQueue('csv-matching') private readonly csvMatchingQueue: Queue,
  ) {}

  async ingestCsv(userId: string, filename: string, csvText: string, ingestJobId: string): Promise<{ count: number }> {
    try {
      const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
      if (parsed.errors?.length) {
        this.logger.warn(`CSV parse had ${parsed.errors.length} errors; proceeding with valid rows`);
      }
      const rows: any[] = (parsed.data as any[]) || [];
      const batch = rows.map((row) => {
        const normalizedTitle = this.normalizeTitle(row.title || row.Name || row.TITLE || '');
        const normalizedSku = (row.sku || row.SKU || row.Sku || '').toString().trim() || null;
        const normalizedBarcode = (row.barcode || row.GTIN || row.UPC || '').toString().trim() || null;
        const normalizedPrice = this.parsePrice(row.price || row.Price || row.PRICE);
        const normalizedQuantity = this.parseQuantity(row.qty || row.Qty || row.Quantity || row.quantity);
        return {
          UserId: userId,
          Source: 'csv',
          OriginalFilename: filename,
          IngestJobId: ingestJobId,
          RawRow: row,
          NormalizedSku: normalizedSku,
          NormalizedBarcode: normalizedBarcode,
          NormalizedTitle: normalizedTitle || null,
          NormalizedPrice: normalizedPrice,
          NormalizedQuantity: normalizedQuantity,
        };
      });

      const supabase = this.supabaseService.getClient();
      const { error } = await supabase.from('RawImportItems').insert(batch);
      if (error) {
        this.logger.error(`Failed to insert RawImportItems: ${error.message}`);
        throw new InternalServerErrorException('CSV ingest failed');
      }

      // Enqueue matching job
      await this.csvMatchingQueue.add('match-csv-import', {
        userId,
        ingestJobId,
      }, {
        delay: 2000, // Small delay to ensure data is committed
      });

      this.logger.log(`Matching job enqueued for ingest job ${ingestJobId}`);
      return { count: batch.length };
    } catch (e: any) {
      this.logger.error(`ingestCsv failed: ${e?.message}`);
      throw e;
    }
  }

  private normalizeTitle(input: string): string {
    return (input || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private parsePrice(value: any): number | null {
    if (value == null) return null;
    const s = String(value).replace(/[^0-9.,-]/g, '').replace(',', '.');
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }

  private parseQuantity(value: any): number | null {
    if (value == null) return null;
    const n = parseInt(String(value).replace(/[^0-9-]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  }
}


