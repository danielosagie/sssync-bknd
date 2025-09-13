import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { SupabaseService } from '../../common/supabase.service';
import { ProductsService } from '../products.service';
import { ActivityLogService } from '../../common/activity-log.service';
import { AiGenerationService } from '../ai-generation/ai-generation.service';
import { FirecrawlService } from '../firecrawl/firecrawl.service';
import { AiUsageTrackerService } from '../ai-usage-tracker/ai-usage-tracker.service';
import { 
  RegenerateJobData, 
  RegenerateJobStatus, 
  RegenerateJobResult 
} from '../types/regenerate-job.types';

@Injectable()
export class RegenerateJobProcessor {
  private readonly logger = new Logger(RegenerateJobProcessor.name);
  
  // In-memory job status tracking for fast access
  private jobStatuses = new Map<string, RegenerateJobStatus>();

  // Stage definitions matching the processing flow
  private readonly stages = [
    'Preparing',
    'Fetching source data',
    'Analyzing requirements',
    'Generating content',
    'Updating products',
    'Ready'
  ] as const;

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly productsService: ProductsService,
    private readonly activityLogService: ActivityLogService,
    private readonly aiGenerationService: AiGenerationService,
    private readonly firecrawlService: FirecrawlService,
    private readonly aiUsageTracker: AiUsageTrackerService,
  ) {}

  /**
   * Process a regenerate job - this is called by the BullMQ worker
   */
  async process(job: Job<RegenerateJobData>): Promise<void> {
    const { jobId, userId, products, options = {} } = job.data;
    
    this.logger.log(`[RegenerateJobProcessor] Starting job ${jobId} for ${products.length} products`);

    // Initialize job status
    const jobStatus: RegenerateJobStatus = {
      jobId,
      userId,
      status: 'processing',
      currentStage: 'Preparing',
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
      const results: RegenerateJobResult[] = [];
      const platformsRegenerated = new Set<string>();

      // Process each product
      for (let i = 0; i < products.length; i++) {
        const product = products[i];
        
        try {
          // Update progress
          await this.updateJobProgress(jobId, i, products.length, 'Analyzing requirements');
          
          this.logger.log(`[RegenerateJobProcessor] Processing product ${i + 1}/${products.length}: ${product.productId}`);
          
          const result = await this.processProductRegeneration(
            product, 
            userId, 
            options,
            jobId
          );
          
          results.push(result);
          
          // Track platforms
          Object.keys(result.platforms).forEach(platform => {
            platformsRegenerated.add(platform);
          });
          
          // Update progress
          await this.updateJobProgress(jobId, i + 1, products.length, 'Generating content');
          
        } catch (error) {
          this.logger.error(`[RegenerateJobProcessor] Error processing product ${product.productId}: ${error.message}`);
          
          // Add failed result
          results.push({
            productIndex: product.productIndex,
            productId: product.productId,
            variantId: product.variantId,
            regenerateType: product.regenerateType,
            platforms: {},
            source: 'ai_generated',
            processingTimeMs: 0,
            error: error.message
          });
          
          jobStatus.progress.failedProducts++;
        }
      }

      // Final update
      await this.updateJobProgress(jobId, products.length, products.length, 'Ready');
      
      // Update final status
      jobStatus.status = 'completed';
      jobStatus.completedAt = new Date().toISOString();
      jobStatus.results = results;
      jobStatus.summary = {
        totalProducts: products.length,
        completed: results.filter(r => !r.error).length,
        failed: results.filter(r => r.error).length,
        averageProcessingTimeMs: results.reduce((sum, r) => sum + r.processingTimeMs, 0) / results.length,
        platformsRegenerated: Array.from(platformsRegenerated)
      };
      jobStatus.updatedAt = new Date().toISOString();

      this.jobStatuses.set(jobId, jobStatus);
      await this.persistJobStatus(jobStatus);

      this.logger.log(`[RegenerateJobProcessor] Completed job ${jobId}: ${jobStatus.summary.completed}/${jobStatus.summary.totalProducts} products processed`);

    } catch (error) {
      this.logger.error(`[RegenerateJobProcessor] Job ${jobId} failed: ${error.message}`);
      
      jobStatus.status = 'failed';
      jobStatus.error = error.message;
      jobStatus.completedAt = new Date().toISOString();
      jobStatus.updatedAt = new Date().toISOString();

      this.jobStatuses.set(jobId, jobStatus);
      await this.persistJobStatus(jobStatus);
      
      throw error;
    }
  }

  /**
   * Process regeneration for a single product
   */
  private async processProductRegeneration(
    product: RegenerateJobData['products'][0],
    userId: string,
    options: RegenerateJobData['options'],
    jobId: string
  ): Promise<RegenerateJobResult> {
    const startTime = Date.now();
    
    try {
      // Get existing product data
      const existingProduct = await this.getProductData(product.productId, userId);
      if (!existingProduct) {
        throw new Error(`Product ${product.productId} not found`);
      }

      // Get source data if specified
      let sourceData = null;
      if (product.sourceJobId && options?.useExistingScrapedData) {
        sourceData = await this.getSourceJobData(product.sourceJobId, userId);
      }

      // Determine what to regenerate
      const regenerateData = await this.determineRegenerationTargets(
        product,
        existingProduct,
        sourceData,
        options
      );

      // Generate new content
      const generatedPlatforms = await this.generatePlatformContent(
        product,
        existingProduct,
        sourceData,
        regenerateData,
        options
      );

      const processingTime = Date.now() - startTime;

      return {
        productIndex: product.productIndex,
        productId: product.productId,
        variantId: product.variantId,
        regenerateType: product.regenerateType,
        platforms: generatedPlatforms,
        source: sourceData ? 'hybrid' : 'ai_generated',
        sourceUrls: sourceData?.urls || [],
        processingTimeMs: processingTime
      };

    } catch (error) {
      const processingTime = Date.now() - startTime;
      
      return {
        productIndex: product.productIndex,
        productId: product.productId,
        variantId: product.variantId,
        regenerateType: product.regenerateType,
        platforms: {},
        source: 'ai_generated',
        processingTimeMs: processingTime,
        error: error.message
      };
    }
  }

  /**
   * Get existing product data from database
   */
  private async getProductData(productId: string, userId: string): Promise<any> {
    const supabase = this.supabaseService.getClient();
    
    const { data, error } = await supabase
      .from('products')
      .select(`
        *,
        variants:product_variants(*)
      `)
      .eq('id', productId)
      .eq('user_id', userId)
      .single();

    if (error) {
      throw new Error(`Failed to fetch product: ${error.message}`);
    }

    return data;
  }

  /**
   * Get source data from previous job
   */
  private async getSourceJobData(sourceJobId: string, userId: string): Promise<any> {
    const supabase = this.supabaseService.getClient();
    
    // Try to get from generate job results first
    const { data: generateData } = await supabase
      .from('generate_job_results')
      .select('*')
      .eq('job_id', sourceJobId)
      .eq('user_id', userId)
      .single();

    if (generateData) {
      return {
        type: 'generate',
        data: generateData,
        urls: generateData.sources?.map(s => s.url) || []
      };
    }

    // Try to get from firecrawl results
    const { data: firecrawlData } = await supabase
      .from('firecrawl_scrapes')
      .select('*')
      .eq('job_id', sourceJobId)
      .eq('user_id', userId)
      .single();

    if (firecrawlData) {
      return {
        type: 'firecrawl',
        data: firecrawlData,
        urls: firecrawlData.scraped_urls || []
      };
    }

    return null;
  }

  /**
   * Determine what needs to be regenerated
   */
  private async determineRegenerationTargets(
    product: RegenerateJobData['products'][0],
    existingProduct: any,
    sourceData: any,
    options: RegenerateJobData['options']
  ): Promise<any> {
    if (product.regenerateType === 'entire_platform') {
      // Regenerate entire platform
      return {
        platforms: [product.targetPlatform],
        fields: 'all'
      };
    } else {
      // Regenerate specific fields
      return {
        platforms: [product.targetPlatform],
        fields: product.targetFields || ['title', 'description']
      };
    }
  }

  /**
   * Generate platform-specific content
   */
  private async generatePlatformContent(
    product: RegenerateJobData['products'][0],
    existingProduct: any,
    sourceData: any,
    regenerateData: any,
    options: RegenerateJobData['options']
  ): Promise<Record<string, any>> {
    const platforms: Record<string, any> = {};

    for (const platform of regenerateData.platforms) {
      try {
        // Build context for AI generation
        const context = this.buildGenerationContext(
          existingProduct,
          sourceData,
          platform,
          product.customPrompt
        );

        // Generate content using AI service
        const generatedContent = await this.aiGenerationService.generatePlatformSpecificContent(
          context,
          platform,
          options?.businessTemplate,
          product.customPrompt
        );

        platforms[platform] = generatedContent;

      } catch (error) {
        this.logger.error(`Failed to generate content for platform ${platform}: ${error.message}`);
        platforms[platform] = { error: error.message };
      }
    }

    return platforms;
  }

  /**
   * Build context for AI generation
   */
  private buildGenerationContext(
    existingProduct: any,
    sourceData: any,
    platform: string,
    customPrompt?: string
  ): any {
    return {
      existingProduct: {
        title: existingProduct.title,
        description: existingProduct.description,
        price: existingProduct.price,
        images: existingProduct.images || []
      },
      sourceData: sourceData?.data || null,
      platform,
      customPrompt
    };
  }

  /**
   * Update job progress
   */
  private async updateJobProgress(
    jobId: string,
    completedProducts: number,
    totalProducts: number,
    stage: typeof this.stages[number]
  ): Promise<void> {
    const jobStatus = this.jobStatuses.get(jobId);
    if (!jobStatus) return;

    const stageIndex = this.stages.indexOf(stage);
    const stagePercentage = Math.round((stageIndex / this.stages.length) * 100);
    
    jobStatus.currentStage = stage;
    jobStatus.progress.completedProducts = completedProducts;
    jobStatus.progress.currentProductIndex = completedProducts;
    jobStatus.progress.stagePercentage = stagePercentage;
    jobStatus.updatedAt = new Date().toISOString();

    this.jobStatuses.set(jobId, jobStatus);
    await this.persistJobStatus(jobStatus);
  }

  /**
   * Persist job status to database
   */
  private async persistJobStatus(jobStatus: RegenerateJobStatus): Promise<void> {
    const supabase = this.supabaseService.getClient();
    
    const { error } = await supabase
      .from('regenerate_job_statuses')
      .upsert({
        job_id: jobStatus.jobId,
        user_id: jobStatus.userId,
        status: jobStatus.status,
        current_stage: jobStatus.currentStage,
        progress: jobStatus.progress,
        results: jobStatus.results,
        summary: jobStatus.summary,
        error: jobStatus.error,
        started_at: jobStatus.startedAt,
        completed_at: jobStatus.completedAt,
        estimated_completion_at: jobStatus.estimatedCompletionAt,
        updated_at: jobStatus.updatedAt
      });

    if (error) {
      this.logger.error(`Failed to persist job status: ${error.message}`);
    }
  }

  /**
   * Get job status by ID
   */
  async getJobStatus(jobId: string, userId: string): Promise<RegenerateJobStatus | null> {
    // Check in-memory first
    const inMemoryStatus = this.jobStatuses.get(jobId);
    if (inMemoryStatus && inMemoryStatus.userId === userId) {
      return inMemoryStatus;
    }

    // Fallback to database
    const supabase = this.supabaseService.getClient();
    const { data, error } = await supabase
      .from('regenerate_job_statuses')
      .select('*')
      .eq('job_id', jobId)
      .eq('user_id', userId)
      .single();

    if (error || !data) {
      return null;
    }

    return {
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
  }

  /**
   * Cancel a job
   */
  async cancelJob(jobId: string, userId: string): Promise<boolean> {
    const jobStatus = this.jobStatuses.get(jobId);
    if (!jobStatus || jobStatus.userId !== userId) {
      return false;
    }

    if (jobStatus.status === 'completed' || jobStatus.status === 'failed') {
      return false; // Cannot cancel completed/failed jobs
    }

    jobStatus.status = 'cancelled';
    jobStatus.completedAt = new Date().toISOString();
    jobStatus.updatedAt = new Date().toISOString();

    this.jobStatuses.set(jobId, jobStatus);
    await this.persistJobStatus(jobStatus);

    return true;
  }
}

