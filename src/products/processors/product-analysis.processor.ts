import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Job } from 'bullmq';
import { ProductsService } from '../products.service';
import { SupabaseService } from '../../common/supabase.service';
import { 
  ProductAnalysisJobData, 
  ProductAnalysisResult, 
  ProductAnalysisJobStatus 
} from '../types/product-analysis-job.types';

@Injectable()
export class ProductAnalysisProcessor {
  private readonly logger = new Logger(ProductAnalysisProcessor.name);
  private jobStatuses = new Map<string, ProductAnalysisJobStatus>();

  constructor(
    private readonly productsService: ProductsService,
    private readonly supabaseService: SupabaseService,
  ) {}

  async process(job: Job<ProductAnalysisJobData>): Promise<void> {
    const { jobId, userId, products, options } = job.data;
    
    this.logger.log(`[ProductAnalysisProcessor] Starting job ${jobId} for ${products.length} products`);
    
    // Initialize job status
    const jobStatus: ProductAnalysisJobStatus = {
      jobId,
      status: 'processing',
      progress: {
        completed: 0,
        total: products.length,
        failed: 0,
        currentProduct: 0,
      },
      results: [],
      summary: {
        totalProducts: products.length,
        highConfidenceCount: 0,
        mediumConfidenceCount: 0,
        lowConfidenceCount: 0,
        estimatedCostPerProduct: 0,
        totalProcessingTimeMs: 0,
      },
      startedAt: new Date().toISOString(),
      estimatedCompletionAt: new Date(Date.now() + products.length * 12000).toISOString(), // 12 seconds per product
    };

    this.jobStatuses.set(jobId, jobStatus);
    await this.saveJobStatusToDatabase(jobStatus);

    try {
      // Process each product
      for (let i = 0; i < products.length; i++) {
        const product = products[i];
        
        // Update current product
        jobStatus.progress.currentProduct = i + 1;
        this.jobStatuses.set(jobId, { ...jobStatus });
        await this.saveJobStatusToDatabase(jobStatus);

        try {
          this.logger.log(`[ProductAnalysisProcessor] Processing product ${i + 1}/${products.length} for job ${jobId}`);
          
          const result = await this.processProduct(product, userId, options);
          
          // Update confidence counts
          if (result.confidence === 'high') jobStatus.summary.highConfidenceCount++;
          else if (result.confidence === 'medium') jobStatus.summary.mediumConfidenceCount++;
          else jobStatus.summary.lowConfidenceCount++;
          
          jobStatus.summary.totalProcessingTimeMs += result.processingTimeMs;
          jobStatus.results.push(result);
          jobStatus.progress.completed++;
          
        } catch (error) {
          this.logger.error(`[ProductAnalysisProcessor] Error processing product ${i + 1}: ${error.message}`);
          
          const failedResult: ProductAnalysisResult = {
            productIndex: product.productIndex,
            productId: product.productId,
            primaryImage: product.images[0]?.url || '',
            textQuery: product.textQuery,
            databaseMatches: [],
            externalMatches: [],
            confidence: 'low',
            processingTimeMs: 0,
            recommendedAction: 'manual_entry',
            error: error.message,
          };
          
          jobStatus.results.push(failedResult);
          jobStatus.progress.failed++;
        }

        // Update job status
        this.jobStatuses.set(jobId, { ...jobStatus });
        await this.saveJobStatusToDatabase(jobStatus);
      }

      // Complete the job
      jobStatus.status = 'completed';
      jobStatus.completedAt = new Date().toISOString();
      jobStatus.summary.estimatedCostPerProduct = jobStatus.summary.totalProcessingTimeMs / products.length / 1000 * 0.01; // Example cost calculation
      
      this.jobStatuses.set(jobId, jobStatus);
      await this.saveJobStatusToDatabase(jobStatus);
      
      this.logger.log(`[ProductAnalysisProcessor] Job ${jobId} completed successfully`);
      
    } catch (error) {
      this.logger.error(`[ProductAnalysisProcessor] Job ${jobId} failed: ${error.message}`);
      
      jobStatus.status = 'failed';
      jobStatus.error = error.message;
      jobStatus.completedAt = new Date().toISOString();
      
      this.jobStatuses.set(jobId, jobStatus);
      await this.saveJobStatusToDatabase(jobStatus);
    }
  }

  private async processProduct(
    product: ProductAnalysisJobData['products'][0], 
    userId: string, 
    options?: ProductAnalysisJobData['options']
  ): Promise<ProductAnalysisResult> {
    const startTime = Date.now();
    
    const primaryImageUrl = product.images[0]?.url || '';
    
    // Step 1: Quick database scan
    const quickScanResult = await this.productsService.quickProductScan({
      imageUrl: primaryImageUrl,
      textQuery: product.textQuery,
      businessTemplate: options?.businessTemplate || 'general',
      threshold: 0.6
    }, userId);

    // Step 2: External analysis (SerpAPI)
    let serpApiAnalysis: any = null;
    let externalMatches: any[] = [];
    
    try {
      const analysisResult = await this.productsService.analyzeAndCreateDraft(
        userId, 
        primaryImageUrl
      );
      
      serpApiAnalysis = analysisResult.analysis || null;
      
      if (serpApiAnalysis?.GeneratedText) {
        const serpData = JSON.parse(serpApiAnalysis.GeneratedText);
        externalMatches = serpData.visual_matches || [];
      }
    } catch (error) {
      this.logger.warn(`External analysis failed for product ${product.productIndex}: ${error.message}`);
    }

    // Step 3: Determine confidence and action
    const topDatabaseScore = quickScanResult.matches.length > 0 ? 
      Math.max(...quickScanResult.matches.map(m => m.combinedScore || 0)) : 0;
    
    let confidence: 'high' | 'medium' | 'low';
    let recommendedAction: 'show_database_match' | 'show_external_matches' | 'manual_entry';

    if (topDatabaseScore >= 0.90) {
      confidence = 'high';
      recommendedAction = 'show_database_match';
    } else if (externalMatches.length >= 3) {
      confidence = 'medium';
      recommendedAction = 'show_external_matches';
    } else if (externalMatches.length >= 1) {
      confidence = 'medium';
      recommendedAction = 'show_external_matches';
    } else {
      confidence = 'low';
      recommendedAction = 'manual_entry';
    }

    const processingTime = Date.now() - startTime;

    return {
      productIndex: product.productIndex,
      productId: product.productId,
      primaryImage: primaryImageUrl,
      textQuery: product.textQuery,
      databaseMatches: quickScanResult.matches,
      externalMatches,
      confidence,
      processingTimeMs: processingTime,
      recommendedAction,
      serpApiAnalysis: serpApiAnalysis ? {
        analysisId: serpApiAnalysis.Id,
        rawData: serpApiAnalysis.GeneratedText,
        metadata: serpApiAnalysis.Metadata,
      } : null,
    };
  }

  private async saveJobStatusToDatabase(jobStatus: ProductAnalysisJobStatus): Promise<void> {
    try {
      const supabase = this.supabaseService.getServiceClient();
      
      // Save to a job_status table (you'll need to create this)
      await supabase
        .from('product_analysis_jobs')
        .upsert({
          job_id: jobStatus.jobId,
          status: jobStatus.status,
          progress: jobStatus.progress,
          results: jobStatus.results,
          summary: jobStatus.summary,
          error: jobStatus.error,
          started_at: jobStatus.startedAt,
          completed_at: jobStatus.completedAt,
          estimated_completion_at: jobStatus.estimatedCompletionAt,
          updated_at: new Date().toISOString(),
        });
        
    } catch (error) {
      this.logger.error(`Failed to save job status to database: ${error.message}`);
    }
  }

  // Public methods for API endpoints
  getJobStatus(jobId: string): ProductAnalysisJobStatus | null {
    return this.jobStatuses.get(jobId) || null;
  }

  async getJobStatusFromDatabase(jobId: string): Promise<ProductAnalysisJobStatus | null> {
    try {
      const supabase = this.supabaseService.getServiceClient();
      
      const { data, error } = await supabase
        .from('product_analysis_jobs')
        .select('*')
        .eq('job_id', jobId)
        .single();

      if (error || !data) {
        return null;
      }

      return {
        jobId: data.job_id,
        status: data.status,
        progress: data.progress,
        results: data.results,
        summary: data.summary,
        error: data.error,
        startedAt: data.started_at,
        completedAt: data.completed_at,
        estimatedCompletionAt: data.estimated_completion_at,
      };
    } catch (error) {
      this.logger.error(`Failed to get job status from database: ${error.message}`);
      return null;
    }
  }

  cancelJob(jobId: string): boolean {
    const jobStatus = this.jobStatuses.get(jobId);
    if (jobStatus && jobStatus.status === 'processing') {
      jobStatus.status = 'cancelled';
      jobStatus.completedAt = new Date().toISOString();
      this.jobStatuses.set(jobId, jobStatus);
      this.saveJobStatusToDatabase(jobStatus);
      return true;
    }
    return false;
  }
} 