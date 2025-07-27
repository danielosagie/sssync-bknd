import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { SupabaseService } from '../../common/supabase.service';
import { ProductsService } from '../products.service';
import { ActivityLogService } from '../../common/activity-log.service';
import { MatchJobData, MatchJobStatus, MatchJobResult } from '../types/match-job.types';

@Injectable()
export class MatchJobProcessor {
  private readonly logger = new Logger(MatchJobProcessor.name);
  
  // In-memory job status tracking for fast access
  private jobStatuses = new Map<string, MatchJobStatus>();

  // Stage definitions matching the mobile screen
  private readonly stages = [
    'Indexing web pages',
    'Found products...',
    'Cleaning product list', 
    'Pulling images',
    'Creating grid',
    'Ready to review'
  ] as const;

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly productsService: ProductsService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  /**
   * Process a match job - this is called by the BullMQ worker
   */
  async process(job: Job<MatchJobData>): Promise<void> {
    const { jobId, userId, products, options = {} } = job.data;
    
    this.logger.log(`[MatchJobProcessor] Starting job ${jobId} for ${products.length} products`);

    // Initialize job status
    const jobStatus: MatchJobStatus = {
      jobId,
      userId,
      status: 'processing',
      currentStage: 'Indexing web pages',
      progress: {
        totalProducts: products.length,
        completedProducts: 0,
        currentProductIndex: 0,
        failedProducts: 0,
        stagePercentage: 0
      },
      results: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Store initial status
    this.jobStatuses.set(jobId, jobStatus);
    await this.persistJobStatus(jobStatus);

    try {
      const results: MatchJobResult[] = [];
      let totalEmbeddingsStored = 0;
      let totalProcessingTime = 0;
      let highConfidenceCount = 0;
      let mediumConfidenceCount = 0;
      let lowConfidenceCount = 0;

      // Process each product through all stages
      for (let i = 0; i < products.length; i++) {
        const product = products[i];
        const productStartTime = Date.now();
        
        // Update current product
        jobStatus.progress.currentProductIndex = i;
        await this.updateJobStatus(jobId, jobStatus);

        this.logger.log(`[MatchJobProcessor] Processing product ${i + 1}/${products.length} for job ${jobId}`);

        // Initialize timing tracking (outside try block for error handling access)
        const timing = {
          quickScanMs: 0,
          serpApiMs: 0,
          embeddingMs: 0,
          vectorSearchMs: 0,
          rerankingMs: 0,
          totalMs: 0
        };

        try {
          
          // Stage 1: Indexing web pages (bulk-recognize with SerpAPI)
          await this.updateStage(jobId, 'Indexing web pages', i, products.length);
          
          const primaryImage = product.images[0];
          if (!primaryImage?.url && !primaryImage?.base64) {
            throw new Error(`Product ${i + 1}: Primary image is required`);
          }

          const primaryImageUrl = primaryImage.url || `data:image/jpeg;base64,${primaryImage.base64}`;

          // Call analyzeAndCreateDraft (SerpAPI) with timing
          const serpApiStart = Date.now();
          const analysisResult = await this.productsService.analyzeAndCreateDraft(
            userId,
            primaryImageUrl
          );
          timing.serpApiMs = Date.now() - serpApiStart;

          // Stage 2: Found products...
          await this.updateStage(jobId, 'Found products...', i, products.length);

          // Extract SerpAPI results
          let serpApiResults: any[] = [];
          if (analysisResult.analysis?.GeneratedText) {
            const serpData = JSON.parse(analysisResult.analysis.GeneratedText);
            serpApiResults = serpData.visual_matches || [];
          }

          if (serpApiResults.length === 0) {
            // No SerpAPI results - return low confidence
            timing.totalMs = Date.now() - productStartTime;
            
            const result: MatchJobResult = {
              productIndex: product.productIndex,
              productId: analysisResult.product.Id,
              variantId: analysisResult.variant.Id,
              serpApiData: serpApiResults,
              rerankedResults: [],
              confidence: 'low',
              vectorSearchFoundResults: false,
              originalTargetImage: primaryImageUrl,
              processingTimeMs: Date.now() - productStartTime,
              timing,
              error: 'No SerpAPI results found'
            };

            results.push(result);
            lowConfidenceCount++;
            continue;
          }

          // Stage 3: Cleaning product list
          await this.updateStage(jobId, 'Cleaning product list', i, products.length);

          // Stage 4: Pulling images (compareResults - embed and compare)
          await this.updateStage(jobId, 'Pulling images', i, products.length);

          const embeddingStart = Date.now();
          const compareResult = await this.productsService.compareResults({
            targetImage: primaryImageUrl,
            serpApiResults,
            productId: analysisResult.product.Id,
            variantId: analysisResult.variant.Id,
            userId,
            options: {
              vectorSearchLimit: options.vectorSearchLimit || 7,
              storeEmbeddings: true,
              useReranking: options.useReranking !== false // Default: true
            }
          });
          timing.embeddingMs = compareResult.metadata.embeddingTimeMs || 0;
          timing.vectorSearchMs = compareResult.metadata.vectorSearchTimeMs || 0;
          timing.rerankingMs = compareResult.metadata.rerankingTimeMs || 0;

          // Stage 5: Creating grid
          await this.updateStage(jobId, 'Creating grid', i, products.length);

          // Build final result
          timing.totalMs = Date.now() - productStartTime;
          
          const result: MatchJobResult = {
            productIndex: product.productIndex,
            productId: analysisResult.product.Id,
            variantId: analysisResult.variant.Id,
            serpApiData: serpApiResults,
            rerankedResults: compareResult.rerankedResults,
            confidence: compareResult.confidence,
            vectorSearchFoundResults: compareResult.vectorSearchFoundResults,
            originalTargetImage: primaryImageUrl,
            processingTimeMs: compareResult.processingTimeMs,
            timing
          };

          results.push(result);
          totalEmbeddingsStored += compareResult.totalEmbeddingsStored;
          totalProcessingTime += compareResult.processingTimeMs;

          // Update confidence counts
          if (compareResult.confidence === 'high') {
            highConfidenceCount++;
          } else if (compareResult.confidence === 'medium') {
            mediumConfidenceCount++;
          } else {
            lowConfidenceCount++;
          }

        } catch (error) {
          this.logger.error(`[MatchJobProcessor] Error processing product ${i + 1}: ${error.message}`);
          
          // Add failed result
          timing.totalMs = Date.now() - productStartTime;
          
          const result: MatchJobResult = {
            productIndex: product.productIndex,
            productId: product.productId || `failed_${i}`,
            variantId: `failed_variant_${i}`,
            serpApiData: [],
            rerankedResults: [],
            confidence: 'low',
            vectorSearchFoundResults: false,
            originalTargetImage: product.images[0]?.url || 'unknown',
            processingTimeMs: Date.now() - productStartTime,
            timing,
            error: error.message
          };

          results.push(result);
          jobStatus.progress.failedProducts++;
          lowConfidenceCount++;
        }

        // Update progress
        jobStatus.progress.completedProducts = i + 1;
        await this.updateJobStatus(jobId, jobStatus);

        // Brief pause between products to avoid rate limits
        if (i < products.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      // Stage 6: Ready to review (final stage)
      await this.updateStage(jobId, 'Ready to review', products.length, products.length);

      // Complete the job
      jobStatus.status = 'completed';
      jobStatus.results = results;
      jobStatus.summary = {
        highConfidenceCount,
        mediumConfidenceCount,
        lowConfidenceCount,
        totalEmbeddingsStored,
        averageProcessingTimeMs: totalProcessingTime / products.length
      };
      jobStatus.completedAt = new Date().toISOString();
      jobStatus.updatedAt = new Date().toISOString();

      await this.updateJobStatus(jobId, jobStatus);

      // Log completion
      await this.activityLogService.logUserAction(
        'MATCH_JOB_COMPLETED',
        'Success',
        `Match job ${jobId} completed for ${products.length} products`,
        {
          action: 'match_job_completed',
          inputData: {
            jobId,
            totalProducts: products.length,
            highConfidenceCount,
            mediumConfidenceCount,
            lowConfidenceCount,
            totalEmbeddingsStored
          }
        },
        userId
      );

      this.logger.log(`[MatchJobProcessor] Job ${jobId} completed successfully`);

    } catch (error) {
      this.logger.error(`[MatchJobProcessor] Job ${jobId} failed: ${error.message}`, error.stack);
      
      // Mark job as failed
      jobStatus.status = 'failed';
      jobStatus.error = error.message;
      jobStatus.completedAt = new Date().toISOString();
      jobStatus.updatedAt = new Date().toISOString();

      await this.updateJobStatus(jobId, jobStatus);

      // Log failure
      await this.activityLogService.logUserAction(
        'MATCH_JOB_FAILED',
        'Error',
        `Match job ${jobId} failed: ${error.message}`,
        {
          action: 'match_job_failed',
          inputData: {
            jobId,
            error: error.message
          }
        },
        userId
      );

      throw error;
    }
  }

  /**
   * Update the current stage with percentage calculation
   */
  private async updateStage(
    jobId: string, 
    stage: typeof this.stages[number], 
    currentProduct: number, 
    totalProducts: number
  ): Promise<void> {
    const jobStatus = this.jobStatuses.get(jobId);
    if (!jobStatus) return;

    const stageIndex = this.stages.indexOf(stage);
    const stageWeight = 100 / this.stages.length; // Each stage is equal weight
    const productProgress = (currentProduct / totalProducts) * stageWeight;
    const previousStagesProgress = stageIndex * stageWeight;
    
    jobStatus.currentStage = stage;
    jobStatus.progress.stagePercentage = Math.min(100, previousStagesProgress + productProgress);
    jobStatus.updatedAt = new Date().toISOString();

    await this.updateJobStatus(jobId, jobStatus);
  }

  /**
   * Update job status in memory and database
   */
  private async updateJobStatus(jobId: string, status: MatchJobStatus): Promise<void> {
    this.jobStatuses.set(jobId, status);
    await this.persistJobStatus(status);
  }

  /**
   * Persist job status to database
   */
  private async persistJobStatus(status: MatchJobStatus): Promise<void> {
    try {
      const supabase = this.supabaseService.getServiceClient();
      
      const { error } = await supabase
        .from('match_jobs')
        .upsert({
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
          updated_at: status.updatedAt
        });

      if (error) {
        this.logger.error(`Failed to persist job status: ${error.message}`);
      }
    } catch (error) {
      this.logger.error(`Error persisting job status: ${error.message}`);
    }
  }

  /**
   * Get job status from memory (fast access)
   */
  getJobStatus(jobId: string): MatchJobStatus | null {
    return this.jobStatuses.get(jobId) || null;
  }

  /**
   * Get job status from database (fallback)
   */
  async getJobStatusFromDatabase(jobId: string): Promise<MatchJobStatus | null> {
    try {
      const supabase = this.supabaseService.getServiceClient();
      
      const { data, error } = await supabase
        .from('match_jobs')
        .select('*')
        .eq('job_id', jobId)
        .single();

      if (error || !data) {
        return null;
      }

      const status: MatchJobStatus = {
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
        updatedAt: data.updated_at
      };

      // Cache in memory for future access
      this.jobStatuses.set(jobId, status);
      
      return status;
    } catch (error) {
      this.logger.error(`Error fetching job status from database: ${error.message}`);
      return null;
    }
  }

  /**
   * Cancel a job (mark as cancelled)
   */
  cancelJob(jobId: string): boolean {
    const jobStatus = this.jobStatuses.get(jobId);
    if (!jobStatus || jobStatus.status === 'completed' || jobStatus.status === 'failed') {
      return false;
    }

    jobStatus.status = 'cancelled';
    jobStatus.completedAt = new Date().toISOString();
    jobStatus.updatedAt = new Date().toISOString();

    this.updateJobStatus(jobId, jobStatus);
    return true;
  }

  /**
   * Clean up old job statuses from memory (call periodically)
   */
  cleanupOldJobs(): void {
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    
    for (const [jobId, status] of this.jobStatuses.entries()) {
      const completedAt = status.completedAt ? new Date(status.completedAt).getTime() : 0;
      if (completedAt && completedAt < oneHourAgo) {
        this.jobStatuses.delete(jobId);
      }
    }
  }
} 