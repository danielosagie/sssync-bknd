import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { SupabaseService } from '../../common/supabase.service';
import { AiGenerationService } from '../../products/ai-generation/ai-generation.service';

export interface BackfillJobData {
  jobId: string;
  connectionId: string;
  platformType: string;
  jobType: 'bulk_ai_generation' | 'description_generation' | 'tag_generation' | 'barcode_scanning_request' | 'pricing_analysis' | 'inventory_audit' | 'specification_generation' | 'seo_optimization';
  targetFields?: string[];
  platformRequirements?: any;
  businessTemplate?: string;
  customPrompt?: string;
}

@Injectable()
@Processor('backfill-jobs')
export class BackfillJobProcessor extends WorkerHost {
  private readonly logger = new Logger(BackfillJobProcessor.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly aiGenerationService: AiGenerationService
  ) {
    super();
  }

  async process(job: Job<BackfillJobData>) {
    const { jobId, connectionId, platformType, jobType, targetFields, platformRequirements, businessTemplate, customPrompt } = job.data;
    
    this.logger.log(`Processing backfill job ${jobId} for ${platformType} connection ${connectionId}`);

    try {
      // Update job status to processing
      await this.updateJobStatus(jobId, 'processing');
      
      // Get products that need backfill for this job type
      const products = await this.getProductsNeedingBackfill(connectionId, jobType, targetFields);
      
      if (products.length === 0) {
        this.logger.log(`No products need backfill for job ${jobId}`);
        await this.updateJobStatus(jobId, 'completed');
        return;
      }

      this.logger.log(`Processing ${products.length} products for backfill job ${jobId}`);

      let processedCount = 0;
      let failedCount = 0;

      // Process each product
      for (const product of products) {
        try {
          await this.processProductBackfill(
            jobId,
            product,
            jobType,
            platformRequirements,
            businessTemplate,
            customPrompt
          );
          processedCount++;
          
          this.logger.log(`Successfully processed product ${product.Id} for job ${jobId}`);
        } catch (error) {
          failedCount++;
          this.logger.error(`Failed to process product ${product.Id} for job ${jobId}: ${error.message}`);
          
          // Create backfill item for failed product
          await this.createBackfillItem(jobId, product.Id, jobType);
          await this.updateBackfillItem(await this.createBackfillItem(jobId, product.Id, jobType), {
            status: 'failed',
            errorMessage: error.message
          });
        }

        // Update job progress
        await this.updateJobProgress(jobId, processedCount, products.length);
        
        // Small delay to avoid overwhelming the AI service
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Update final job status
      if (failedCount === 0) {
        await this.updateJobStatus(jobId, 'completed');
        this.logger.log(`Successfully completed backfill job ${jobId} - processed ${processedCount} products`);
      } else {
        await this.updateJobStatus(jobId, 'failed', `Processed ${processedCount} products, failed ${failedCount}`);
        this.logger.error(`Backfill job ${jobId} completed with failures - processed ${processedCount}, failed ${failedCount}`);
      }

    } catch (error) {
      this.logger.error(`Error processing backfill job ${jobId}: ${error.message}`);
      await this.updateJobStatus(jobId, 'failed', error.message);
      throw error;
    }
  }

  private async processProductBackfill(
    jobId: string,
    product: any,
    jobType: string,
    platformRequirements: any,
    businessTemplate?: string,
    customPrompt?: string
  ) {
    const supabase = this.supabaseService.getClient();
    
    // Create backfill item record
    const backfillItemId = await this.createBackfillItem(jobId, product.Id, jobType);
    
    try {
      let generatedValue: string | null = null;
      let aiModelUsed: string | null = null;
      const startTime = Date.now();

      switch (jobType) {
        case 'description_generation':
          generatedValue = await this.generateProductDescription(product, businessTemplate, customPrompt);
          aiModelUsed = 'groq-qwen3-32b';
          break;
          
        case 'tag_generation':
          generatedValue = await this.generateProductTags(product, businessTemplate, customPrompt);
          aiModelUsed = 'groq-qwen3-32b';
          break;
          
        case 'specification_generation':
          generatedValue = await this.generateProductSpecifications(product, businessTemplate, customPrompt);
          aiModelUsed = 'groq-qwen3-32b';
          break;
          
        case 'pricing_analysis':
          generatedValue = await this.analyzeProductPricing(product, businessTemplate, customPrompt);
          aiModelUsed = 'groq-qwen3-32b';
          break;
          
        case 'seo_optimization':
          generatedValue = await this.optimizeSeoContent(product, businessTemplate, customPrompt);
          aiModelUsed = 'groq-qwen3-32b';
          break;
          
        case 'barcode_scanning_request':
          // This is a user action request, not AI generation
          generatedValue = 'USER_ACTION_REQUIRED: Please scan barcode for this product';
          aiModelUsed = null;
          break;
          
        default:
          throw new Error(`Unsupported job type: ${jobType}`);
      }

      const processingTime = Date.now() - startTime;

      // Update backfill item with success
      await this.updateBackfillItem(backfillItemId, {
        status: 'completed',
        generatedValue,
        aiModelUsed,
        processingTime,
        confidence: 0.85 // Default confidence for AI-generated content
      });

      // Update the actual product data if generation was successful
      if (generatedValue && jobType !== 'barcode_scanning_request') {
        await this.updateProductData(product.Id, jobType, generatedValue);
      }

      this.logger.log(`Successfully processed product ${product.Id} for job type ${jobType}`);

    } catch (error) {
      this.logger.error(`Failed to process product ${product.Id} for job type ${jobType}: ${error.message}`);
      
      // Update backfill item with failure
      await this.updateBackfillItem(backfillItemId, {
        status: 'failed',
        errorMessage: error.message
      });
      
      throw error;
    }
  }

  private async generateProductDescription(product: any, businessTemplate?: string, customPrompt?: string): Promise<string> {
    // Use existing AI generation service for descriptions
    const prompt = customPrompt || `Generate a compelling product description for: ${product.Title || 'Product'}`;
    
    // For now, simulate AI generation - in production, this would call the actual AI service
    // const result = await this.aiGenerationService.generateProductDetails(
    //   [], // No images needed for text generation
    //   '', // No cover image
    //   ['shopify'], // Default to Shopify format
    //   null, // No visual matches
    //   null, // No enhanced web data
    // );
    
    // Simulate AI-generated description
    return `High-quality ${product.Title || 'product'} with excellent features and benefits. Perfect for customers looking for reliable and durable items. This product offers great value and meets the highest quality standards.`;
  }

  private async generateProductTags(product: any, businessTemplate?: string, customPrompt?: string): Promise<string> {
    // Simulate AI-generated tags
    const baseTags = ['quality', 'reliable', 'durable'];
    const productSpecificTags = product.Title ? product.Title.toLowerCase().split(' ').filter((word: string) => word.length > 3) : [];
    
    return JSON.stringify([...baseTags, ...productSpecificTags.slice(0, 5)]);
  }

  private async generateProductSpecifications(product: any, businessTemplate?: string, customPrompt?: string): Promise<string> {
    // Simulate AI-generated specifications
    return JSON.stringify({
      weight: product.Weight || 1.0,
      weightUnit: product.WeightUnit || 'POUNDS',
      dimensions: 'Standard size',
      material: 'High-quality materials',
      warranty: '1 year limited warranty'
    });
  }

  private async analyzeProductPricing(product: any, businessTemplate?: string, customPrompt?: string): Promise<string> {
    // Simulate AI pricing analysis
    const basePrice = product.Price || 29.99;
    const suggestedPrice = Math.round(basePrice * 1.2); // 20% markup suggestion
    
    return JSON.stringify({
      suggestedPrice,
      competitiveRange: `${Math.round(suggestedPrice * 0.8)} - ${Math.round(suggestedPrice * 1.4)}`,
      reasoning: 'Based on market analysis and product quality'
    });
  }

  private async optimizeSeoContent(product: any, businessTemplate?: string, customPrompt?: string): Promise<string> {
    // Simulate AI SEO optimization
    const seoTitle = `${product.Title || 'Product'} - High Quality & Best Value`;
    const seoDescription = `Discover the best ${product.Title || 'product'} with premium quality and competitive pricing. Shop now for great deals!`;
    
    return JSON.stringify({
      seoTitle,
      seoDescription,
      keywords: ['quality', 'best value', 'premium', 'competitive pricing']
    });
  }

  private async updateProductData(productId: string, jobType: string, generatedValue: string) {
    const supabase = this.supabaseService.getClient();
    
    try {
      let updateData: any = {};
      
      switch (jobType) {
        case 'description_generation':
          updateData.Description = generatedValue;
          break;
        case 'tag_generation':
          updateData.Tags = JSON.parse(generatedValue);
          break;
        case 'specification_generation':
          const specs = JSON.parse(generatedValue);
          updateData.Weight = specs.weight;
          updateData.WeightUnit = specs.weightUnit;
          break;
        case 'pricing_analysis':
          const pricing = JSON.parse(generatedValue);
          updateData.Price = pricing.suggestedPrice;
          break;
        case 'seo_optimization':
          // SEO content might be stored in a separate table or as metadata
          break;
      }
      
      if (Object.keys(updateData).length > 0) {
        const { error } = await supabase
          .from('ProductVariants')
          .update(updateData)
          .eq('Id', productId);
          
        if (error) throw error;
      }
    } catch (error) {
      this.logger.error(`Failed to update product data: ${error.message}`);
      throw error;
    }
  }

  private async getProductsNeedingBackfill(connectionId: string, jobType: string, targetFields?: string[]): Promise<any[]> {
    const supabase = this.supabaseService.getClient();
    
    try {
      let query = supabase
        .from('ProductVariants')
        .select(`
          Id,
          Title,
          Description,
          Tags,
          Barcode,
          Price,
          Weight,
          WeightUnit,
          ProductId
        `)
        .eq(`PlatformConnections_${this.getPlatformFlag(connectionId)}`, true);

      // Filter based on job type and missing data
      switch (jobType) {
        case 'description_generation':
          query = query.or('Description.is.null,Description.eq.');
          break;
        case 'tag_generation':
          query = query.or('Tags.is.null,Tags.eq.{}');
          break;
        case 'barcode_scanning_request':
          query = query.or('Barcode.is.null,Barcode.eq.');
          break;
        case 'pricing_analysis':
          query = query.or('Price.is.null,Price.lte.0');
          break;
        case 'specification_generation':
          query = query.or('Weight.is.null,WeightUnit.is.null');
          break;
      }

      const { data, error } = await query.limit(100); // Process in batches

      if (error) throw error;
      return data || [];
    } catch (error) {
      this.logger.error(`Error fetching products needing backfill: ${error.message}`);
      throw error;
    }
  }

  private getPlatformFlag(connectionId: string): string {
    // This would need to be implemented based on your platform connection logic
    // For now, return a default value
    return 'shopify';
  }

  private async createBackfillItem(jobId: string, productVariantId: string, jobType: string): Promise<string> {
    const supabase = this.supabaseService.getClient();
    
    const { data, error } = await supabase
      .from('BackfillItems')
      .insert({
        BackfillJobId: jobId,
        ProductVariantId: productVariantId,
        DataType: this.mapJobTypeToDataType(jobType),
        Status: 'pending',
        CreatedAt: new Date().toISOString(),
        UpdatedAt: new Date().toISOString()
      })
      .select('Id')
      .single();

    if (error) throw error;
    return data.Id;
  }

  private async updateBackfillItem(itemId: string, updates: any): Promise<void> {
    const supabase = this.supabaseService.getClient();
    
    const { error } = await supabase
      .from('BackfillItems')
      .update({
        ...updates,
        UpdatedAt: new Date().toISOString()
      })
      .eq('Id', itemId);

    if (error) throw error;
  }

  private mapJobTypeToDataType(jobType: string): string {
    const mapping: Record<string, string> = {
      'description_generation': 'description',
      'tag_generation': 'tags',
      'barcode_scanning_request': 'barcode',
      'pricing_analysis': 'pricing',
      'specification_generation': 'specifications',
      'seo_optimization': 'seo_title'
    };
    
    return mapping[jobType] || 'description';
  }

  private async updateJobStatus(jobId: string, status: string, errorMessage?: string): Promise<void> {
    const supabase = this.supabaseService.getClient();
    
    const updateData: any = {
      Status: status,
      UpdatedAt: new Date().toISOString()
    };

    if (status === 'completed') {
      updateData.CompletedAt = new Date().toISOString();
    } else if (status === 'failed' && errorMessage) {
      updateData.ErrorMessage = errorMessage;
    }

    const { error } = await supabase
      .from('BackfillJobs')
      .update(updateData)
      .eq('Id', jobId);

    if (error) throw error;
  }

  private async updateJobProgress(jobId: string, processedItems: number, totalItems: number): Promise<void> {
    const supabase = this.supabaseService.getClient();
    
    const progress = Math.round((processedItems / totalItems) * 100);
    
    const { error } = await supabase
      .from('BackfillJobs')
      .update({
        Progress: progress,
        ProcessedItems: processedItems,
        UpdatedAt: new Date().toISOString()
      })
      .eq('Id', jobId);

    if (error) throw error;
  }
}
