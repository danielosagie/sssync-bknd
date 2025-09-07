import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { SupabaseService } from '../../common/supabase.service';
import { ProductsService } from '../products.service';
import { ActivityLogService } from '../../common/activity-log.service';
import { AiGenerationService } from '../ai-generation/ai-generation.service';
import { FirecrawlService } from '../firecrawl.service';
import { GenerateJobData, GenerateJobStatus, GenerateJobResult } from '../types/generate-job.types';
import { AiUsageTrackerService } from '../../common/ai-usage-tracker.service';
import { SupabaseClient } from '@supabase/supabase-js';


@Injectable()
export class GenerateJobProcessor {
  private readonly logger = new Logger(GenerateJobProcessor.name);
  private jobStatuses = new Map<string, GenerateJobStatus>();

  private getSupabaseClient(): SupabaseClient {
    return this.supabaseService.getClient();
  }

  private readonly stages = [
    'Preparing',
    'Fetching sources',
    'Scraping sources',
    'Generating details',
    'Saving drafts',
    'Ready',
  ] as const;

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly productsService: ProductsService,
    private readonly activityLogService: ActivityLogService,
    private readonly aiGenerationService: AiGenerationService,
    private readonly firecrawlService: FirecrawlService,
    private readonly aiUsageTracker: AiUsageTrackerService
  ) {}

  async process(job: Job<GenerateJobData>): Promise<void> {
    const { jobId, userId, userJwtToken, products, selectedPlatforms, options, platformRequests, templateSources } = job.data;

    const jobStatus: GenerateJobStatus = {
      jobId,
      userId,
      status: 'processing',
      currentStage: 'Preparing',
      progress: {
        totalProducts: products.length,
        completedProducts: 0,
        currentProductIndex: 0,
        failedProducts: 0,
        stagePercentage: 0,
      },
      results: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.jobStatuses.set(jobId, jobStatus);
    await this.persistJobStatus(jobStatus);

    try {
      const results: GenerateJobResult[] = [];
      let totalProcessingTime = 0;


      for (let i = 0; i < products.length; i++) {
        const p = products[i];
        const productStart = Date.now();
        jobStatus.progress.currentProductIndex = i;
        await this.updateStage(jobId, 'Fetching sources', i, products.length);

        const coverUrl = p.imageUrls[p.coverImageIndex];
        let usedSources: string[] = [];

        // Optionally scrape sources using user-selected URLs and template search
        let scrapedDataArray: any[] | null = null;
        if (options?.useScraping) {
          await this.updateStage(jobId, 'Scraping sources', i, products.length);
          try {
            const selectedLinks: string[] = Array.from(new Set([
              ...((p.selectedMatches || []).map((m: any) => m.link).filter((u: any) => typeof u === 'string' && u.length > 0)),
              ...((templateSources || []).filter((u: any) => typeof u === 'string' && u.length > 0)),
            ]));

            const templateName: string | undefined = (job as any).data.template || undefined;

            // If a template is provided, perform a Firecrawl search to find additional sources
            let templateSearchUrls: string[] = [];
            if (templateName) {

              try {
                const titleForQuery = (p.selectedMatches && p.selectedMatches[0]?.title) ? p.selectedMatches[0].title : 'product';
                const prompt = `Find the product data for this product: (${titleForQuery})` +
                  (selectedLinks.length ? ` at this link(s): (${selectedLinks.map(u => new URL(u).origin).join(', ')})` : '');
                this.logger.log(`[GenerateJob] Firecrawl search prompt: ${prompt}`);
                const searchResult = await this.firecrawlService.search(prompt); 

                this.logger.log('Search Result: ' + searchResult);

                try {
                   const supabase = this.supabaseService.getServiceClient();
                   // Skip database logging if no productId (happens when generate called without match first)
                   if (p.productId) {
                     const { data, error } = await supabase.from('AiGeneratedContent').insert({
                       ProductId: p.productId, // Use ProductId from match processor
                       ContentType: 'search', 
                       SourceApi: 'firecrawl',
                       Prompt: `generate_job_scrape:${jobId}:product_${i+1}`,
                       GeneratedText: JSON.stringify({ searchResult }),
                       Metadata: { jobId, productIndex: i, template: (job as any).data.template || undefined, userId },
                       IsActive: false,
                       job_Id: jobId,
                     });

                     if (error) {
                       this.logger.error(`Failed to save search results to DB: ${error.message}`);
                     } else {
                       this.logger.log(`Successfully saved search results to DB: ${data || 0} records`);
                     }
                   } else {
                     this.logger.warn(`Skipping search results DB save - no productId available for product ${i+1}`);
                   }
                 } catch (error) {
                   this.logger.error(`Exception saving search results: ${error.message}`);
                 }
                
                
                // Log result NOT WORKING YET
                await this.aiUsageTracker.trackUsage({
                  userId: userId,
                  serviceType: 'firecrawl_search',
                  modelName: 'firecrawl',
                  operation: 'firecrawl_search',
                  requestCount: 1,
                  metadata: searchResult
                });
            

                const data = Array.isArray(searchResult?.data) ? searchResult.data : [];
                templateSearchUrls = data.map((r: any) => r.url).filter((u: any) => typeof u === 'string');
                this.logger.log(`[GenerateJob] Firecrawl search returned ${templateSearchUrls.length} candidate URL(s)`);
              } catch (searchErr) {
                this.logger.warn(`[GenerateJob] Firecrawl search failed for template '${templateName}': ${searchErr.message}`);
              }
            }

            const urlsToScrape = Array.from(new Set([
              ...selectedLinks,
              ...templateSearchUrls,
            ])).slice(0, 8); // limit
            usedSources = urlsToScrape;

            this.logger.log(`[GenerateJob] URLs to scrape for product ${i + 1}: ${urlsToScrape.length}`);
            if (urlsToScrape.length) {
              this.logger.debug(`[GenerateJob] URLs: ${urlsToScrape.map(u => {
                try { return new URL(u).origin; } catch { return u; }
              }).join(', ')}`);
            }

            if (urlsToScrape.length > 0) {
              const schema = this.firecrawlService.getProductSchema(templateName);
              // New behavior: perform a Firecrawl search using product title/query and then extract from top URLs

              try {
                const titleForQuery = (p.selectedMatches && p.selectedMatches[0]?.title) ? p.selectedMatches[0].title : 'product';
                
                // Use Promise.all for proper async handling
                const scrapePromises = urlsToScrape.map(async link => {
                  try {
                    const searchResult = await this.firecrawlService.scrape(link);
                    const data = searchResult?.data || searchResult || {};
                    return {
                      url: link,
                      json: data.json || {},
                      markdown: data.markdown || '',
                      data: data
                    };
                  } catch (error) {
                    this.logger.warn(`Scrape failed for ${link}: ${error?.message || error}`);
                    return { url: link, json: {}, markdown: '', data: {} };
                  }
                });
                this.logger.log(`URLs to be scraped: ${urlsToScrape.length} URLs`);
                

    
                const scrapeResults = await Promise.all(scrapePromises);
                this.logger.log(`Total returned response from firecrawl: ${scrapeResults.length} results, extracted content from ${scrapeResults.filter(r => r.json || r.markdown).length} URLs`);

                // Filter out empty results and format for AI consumption
                const validResults = scrapeResults.filter(r => 
                  (r.json && Object.keys(r.json).length > 0) || 
                  (r.markdown && r.markdown.trim().length > 0)
                );
                
                this.logger.log(`Scrape Results: ${validResults.length} valid results with content`);
                
                // Adapt to AI service expectation (objects with data.markdown)
                scrapedDataArray = validResults.map((result: any) => ({
                  data: {
                    markdown: result.markdown || JSON.stringify(result.json),
                    url: result.url,
                    extractedData: result.json
                  }
                }));
                this.logger.log(`Scraped Data Array Stage: ${scrapedDataArray.length} items prepared for AI`);
                
              } catch (searchErr) {
                this.logger.warn(`[GenerateJob] Firecrawl search phase failed: ${searchErr?.message || searchErr}`);
                scrapedDataArray = [];
              }
              this.logger.log(`[GenerateJob] Extracted structured data from ${scrapedDataArray.length} URL(s)`);

              // Log scrape event for training/analytics
              try {
                
                this.logger.log(scrapedDataArray);

                try {
                   // Storing Scrape Job - only if productId available
                   if (p.productId) {
                     const supabase = this.supabaseService.getServiceClient();
                     const { data, error } = await supabase.from('AiGeneratedContent').insert({
                       ProductId: p.productId, // Use ProductId from match processor
                       ContentType: 'scrape',
                       SourceApi: 'firecrawl',
                       Prompt: `generate_job_scrape:${jobId}:product_${i+1}`,
                       GeneratedText: JSON.stringify({ 
                         urls: urlsToScrape, 
                         extractedCount: scrapedDataArray.length,
                         scrapedData: scrapedDataArray 
                       }),
                       Metadata: { jobId, productIndex: i, template: (job as any).data.template || undefined, userId },
                       IsActive: false,
                     });

                     if (error) {
                       this.logger.error(`Failed to save scrape results to DB: ${error.message}`);
                     } else {
                       this.logger.log(`Successfully saved scrape results to DB: ${data || 0} records with ${scrapedDataArray.length} scraped items`);
                     }
                   } else {
                     this.logger.warn(`Skipping scrape results DB save - no productId available for product ${i+1}`);
                   }
                 } catch (error) {
                   this.logger.error(`Exception saving scrape results: ${error.message}`);
                 }

                // Log result
                await this.aiUsageTracker.trackUsage({
                  userId: userId,
                  serviceType: 'firecrawl_scrape',
                  modelName: 'firecrawl',
                  operation: 'firecrawl_scrape',
                  requestCount: 1,
                  metadata: { scrapedDataArray }
                });

              } catch (error) {
                this.logger.warn(`[GenerateJob] Failed to log scrape event: ${error?.message || error}`);
              }
            } else {
              scrapedDataArray = null;
            }
          } catch (error) {
            this.logger.warn(`[GenerateJob] Scrape pipeline failed for product ${i + 1}: ${error.message}`);
            scrapedDataArray = null;
          }
        }

        await this.updateStage(jobId, 'Generating details', i, products.length);
         let generated: any = null;
        try {
           if (scrapedDataArray && scrapedDataArray.length > 0) {
            this.logger.log(`[GenerateJob] Generating using scraped context for product ${i + 1}`);
            const contextQuery = (p.selectedMatches && p.selectedMatches[0]?.title) ? p.selectedMatches[0].title : 'Product';
            generated = await this.aiGenerationService.generateProductDetailsFromScrapedData(
              scrapedDataArray,
              contextQuery,
              (job as any).data.template || undefined,
              {
                selectedSerpApiResult: p.selectedMatches?.[0],
                platformRequests: (platformRequests && platformRequests.length > 0)
                  ? platformRequests
                  : selectedPlatforms.map(platform => ({ platform })),
                targetSites: (p.selectedMatches || []).map((m: any) => {
                  try { return new URL(m.link).origin; } catch { return null; }
                }).filter(Boolean) as string[],
              }
            );
           } else {
            this.logger.log(`[GenerateJob] Generating from image(s) only (no scraped context) for product ${i + 1}`);
            generated = await this.aiGenerationService.generateProductDetails(
              p.imageUrls,
              coverUrl,
              selectedPlatforms,
              p.selectedMatches ? { visual_matches: p.selectedMatches as any } : null,
              null,
            );
          }
        } catch (err) {
          this.logger.error(`[GenerateJob] Generation failed for product ${i + 1}: ${err.message}`);
        }

         await this.updateStage(jobId, 'Saving drafts', i, products.length);
        // Persist generated data to DB as AI content or draft fields (skipping platform publish here)
        // You can extend ProductsService to store AI suggestions tied to product/variant


        const processingTimeMs = Date.now() - productStart;
        totalProcessingTime += processingTimeMs;

         const result: GenerateJobResult = {
          productIndex: p.productIndex,
          productId: p.productId,
          variantId: p.variantId,
          platforms: (generated as any) || {},
          sourceImageUrl: coverUrl,
          processingTimeMs,
          source: scrapedDataArray && scrapedDataArray.length > 0 ? 'hybrid' : 'ai_generated',
           sources: (usedSources && usedSources.length ? usedSources : (p.selectedMatches || []).map((m:any)=>m?.link).filter(Boolean)).map((u:string)=>({ url: u })),
        };

         const platformKeys = Object.keys(result.platforms || {});
        this.logger.log(`[GenerateJob] Generated platform data for product ${i + 1}: ${platformKeys.join(', ') || 'none'}`);

         // Log generate event - only if productId available
         try {
           if (p.productId) {
             const supabase = this.supabaseService.getServiceClient();
             const { data, error } = await supabase.from('AiGeneratedContent').insert({
              ProductId: p.productId, // Use ProductId from match processor
              ContentType: 'generate',
              SourceApi: scrapedDataArray && scrapedDataArray.length > 0 ? 'firecrawl+groq' : 'groq',
              Prompt: `generate_job:${jobId}:product_${i+1}`,
              GeneratedText: JSON.stringify({ platforms: result.platforms }),
              Metadata: {
                productIndex: p.productIndex,
                variantId: p.variantId || null,
                platforms: platformKeys,
                source: result.source,
                processingTimeMs,
                sources: (p.selectedMatches || []).map((m: any) => ({ url: m?.link })).filter(Boolean)
              },
              IsActive: false,
              job_Id: jobId,
             });

             if (error) {
               this.logger.error(`Failed to save generate results to DB: ${error.message}`);
             } else {
               this.logger.log(`Successfully saved generate results to DB: ${data || 0} records for ${platformKeys.length} platforms`);
             }
           } else {
             this.logger.warn(`Skipping generate results DB save - no productId available for product ${i+1}`);
           }

           this.logger.log(`Generation result for product ${i+1}: ${platformKeys.join(', ')} platforms generated`);

          
           // Log result
           await this.aiUsageTracker.trackUsage({
            userId: userId,
            serviceType: 'generation',
            modelName: 'qwen3',
            operation: 'generation',
            requestCount: 1,
            metadata: { generated }
          });
         } catch (error) {
           this.logger.warn(`[GenerateJob] Failed to log generate event: ${error?.message || error}`);
         }

        results.push(result);
        jobStatus.progress.completedProducts = i + 1;
        await this.updateJobStatus(jobId, jobStatus);
      }

      await this.updateStage(jobId, 'Ready', products.length, products.length);
      jobStatus.status = 'completed';
      jobStatus.results = results;
      jobStatus.summary = {
        totalProducts: products.length,
        completed: results.length,
        failed: jobStatus.progress.failedProducts,
        averageProcessingTimeMs: results.length ? totalProcessingTime / results.length : 0,
      };
      jobStatus.completedAt = new Date().toISOString();
      jobStatus.updatedAt = new Date().toISOString();
      await this.updateJobStatus(jobId, jobStatus);

      await this.activityLogService.logUserAction(
        'GENERATE_JOB_COMPLETED',
        'Success',
        `Generate job ${jobId} completed for ${products.length} products`,
        {
          action: 'generate_job_completed',
          inputData: {
            jobId,
            totalProducts: products.length,
          },
        },
        userId,
      );

      this.logger.log(`[GenerateJob] Job ${jobId} completed successfully`);
    } catch (error) {
      this.logger.error(`[GenerateJob] Job ${jobId} failed: ${error.message}`, error.stack);
      jobStatus.status = 'failed';
      jobStatus.error = error.message;
      jobStatus.completedAt = new Date().toISOString();
      jobStatus.updatedAt = new Date().toISOString();
      await this.updateJobStatus(jobId, jobStatus);

      await this.activityLogService.logUserAction(
        'GENERATE_JOB_FAILED',
        'Error',
        `Generate job ${jobId} failed: ${error.message}`,
        {
          action: 'generate_job_failed',
          inputData: { jobId, error: error.message },
        },
        userId,
      );

      throw error;
    }
  }

  private async updateStage(
    jobId: string,
    stage: typeof this.stages[number],
    currentProduct: number,
    totalProducts: number,
  ): Promise<void> {
    const jobStatus = this.jobStatuses.get(jobId);
    if (!jobStatus) return;
    const stageIndex = this.stages.indexOf(stage);
    const stageWeight = 100 / this.stages.length;
    const productProgress = (currentProduct / totalProducts) * stageWeight;
    const previousStagesProgress = stageIndex * stageWeight;

    jobStatus.currentStage = stage as any;
    jobStatus.progress.stagePercentage = Math.min(100, previousStagesProgress + productProgress);
    jobStatus.updatedAt = new Date().toISOString();
    await this.updateJobStatus(jobId, jobStatus);
  }

  private async updateJobStatus(jobId: string, status: GenerateJobStatus): Promise<void> {
    this.jobStatuses.set(jobId, status);
    await this.persistJobStatus(status);
  }

  private async persistJobStatus(status: GenerateJobStatus): Promise<void> {
    try {
      const supabase = this.supabaseService.getServiceClient();
      const { error } = await supabase
        .from('generate_jobs')
        .upsert(
          {
            job_id: status.jobId,
            user_id: status.userId,
            status: status.status,
            current_stage: status.currentStage,
            progress: status.progress,
            results: status.results,
            summary: status.summary,
            error: status.error,
            started_at: status.startedAt,
            completed_at: status.completedAt,
            estimated_completion_at: status.estimatedCompletionAt,
            updated_at: status.updatedAt,
          },
          { onConflict: 'job_id' },
        );
      if (error) this.logger.error(`Failed to persist generate job: ${error.message}`);
    } catch (err) {
      this.logger.error(`Error persisting generate job: ${err.message}`);
    }
  }

  getJobStatus(jobId: string): GenerateJobStatus | null {
    return this.jobStatuses.get(jobId) || null;
  }

  async getJobStatusFromDatabase(jobId: string): Promise<GenerateJobStatus | null> {
    try {
      const supabase = this.supabaseService.getServiceClient();
      const { data } = await supabase
        .from('generate_jobs')
        .select('*')
        .eq('job_id', jobId)
        .single();
      if (!data) return null;
      const status: GenerateJobStatus = {
        jobId: data.job_id,
        userId: data.user_id,
        status: data.status,
        currentStage: data.current_stage,
        progress: data.progress,
        results: data.results || [],
        summary: data.summary,
        error: data.error,
        startedAt: data.started_at,
        completedAt: data.completed_at,
        estimatedCompletionAt: data.estimated_completion_at,
        updatedAt: data.updated_at,
      } as any;
      this.jobStatuses.set(jobId, status);
      return status;
    } catch (err) {
      this.logger.error(`Error fetching generate job from DB: ${err.message}`);
      return null;
    }
  }

  cancelJob(jobId: string): boolean {
    const jobStatus = this.jobStatuses.get(jobId);
    if (!jobStatus || jobStatus.status === 'completed' || jobStatus.status === 'failed') return false;
    jobStatus.status = 'cancelled';
    jobStatus.completedAt = new Date().toISOString();
    jobStatus.updatedAt = new Date().toISOString();
    this.updateJobStatus(jobId, jobStatus);
    return true;
  }

  cleanupOldJobs(): void {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    for (const [jobId, status] of this.jobStatuses.entries()) {
      const completedAt = status.completedAt ? new Date(status.completedAt).getTime() : 0;
      if (completedAt && completedAt < oneHourAgo) this.jobStatuses.delete(jobId);
    }
  }
}




