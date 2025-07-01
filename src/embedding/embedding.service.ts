import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../common/supabase.service';
import { AiUsageTrackerService } from '../common/ai-usage-tracker.service';

export interface ImageEmbeddingInput {
  imageUrl?: string;
  imageBase64?: string;
  instruction?: string;
}

export interface TextEmbeddingInput {
  title: string;
  description?: string;
  category?: string;
  brand?: string;
  tags?: string[];
  price?: number;
  businessTemplate?: string;
}

export interface MultiModalEmbeddingInput {
  image?: ImageEmbeddingInput;
  text?: TextEmbeddingInput;
  userId?: string;
}

export interface EmbeddingResponse {
  imageEmbedding?: number[];
  textEmbedding?: number[];
  combinedEmbedding?: number[];
  dimensions: {
    image?: number;
    text?: number;
    combined?: number;
  };
  models: {
    image?: string;
    text?: string;
  };
}

export interface ProductMatch {
  productId: string;
  variantId: string;
  title: string;
  description?: string;
  imageUrl?: string;
  businessTemplate?: string;
  imageSimilarity: number;
  textSimilarity: number;
  combinedScore: number;
}

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly aiServerUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly supabaseService: SupabaseService,
    private readonly aiUsageTracker: AiUsageTrackerService
  ) {
    this.aiServerUrl = this.configService.get<string>('AI_SERVER_URL') || 'http://localhost:8000';
  }

  /**
   * Generate image embeddings using SigLIP 2
   */
  async generateImageEmbedding(input: ImageEmbeddingInput, userId?: string): Promise<number[]> {
    const startTime = Date.now();
    
    try {
      let imageData: string;
      
      if (input.imageBase64) {
        imageData = input.imageBase64;
      } else if (input.imageUrl) {
        // Download and convert to base64
        imageData = await this.downloadImageAsBase64(input.imageUrl);
      } else {
        throw new Error('Either imageUrl or imageBase64 must be provided');
      }

      const response = await fetch(`${this.aiServerUrl}/embed/image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_data: imageData,
          instruction: input.instruction || 'Encode this product image for visual similarity search'
        }),
      });

      if (!response.ok) {
        throw new Error(`Image embedding API error: ${response.statusText}`);
      }

      const data = await response.json();
      const processingTime = Date.now() - startTime;

      // Track AI usage
      await this.aiUsageTracker.trackUsage({
        userId: userId || 'anonymous',
        serviceType: 'siglip_embedding',
        modelName: 'google/siglip-large-patch16-384',
        operation: 'generate_image_embedding',
        requestCount: 1,
        metadata: { hasImageUrl: !!input.imageUrl, hasImageBase64: !!input.imageBase64 }
      });

      return data.embeddings[0];
      
    } catch (error) {
      const processingTime = Date.now() - startTime;
      
      if (userId) {
        await this.aiUsageTracker.trackUsage({
          userId,
          serviceType: 'siglip_embedding',
          modelName: 'google/siglip-large-patch16-384',
          operation: 'generate_image_embedding_error',
          requestCount: 1,
          metadata: { error: error.message }
        });
      }

      this.logger.error('Failed to generate image embedding:', error);
      throw error;
    }
  }

  /**
   * Generate text embeddings using Qwen3
   */
  async generateTextEmbedding(input: TextEmbeddingInput, userId?: string): Promise<number[]> {
    const startTime = Date.now();
    
    try {
      const productText = this.formatProductText(input);
      const instruction = this.buildTextInstruction(input);

      const response = await fetch(`${this.aiServerUrl}/embed/text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          texts: [productText],
          instruction,
          normalize: true
        }),
      });

      if (!response.ok) {
        throw new Error(`Text embedding API error: ${response.statusText}`);
      }

      const data = await response.json();
      const processingTime = Date.now() - startTime;

      // Track AI usage
      await this.aiUsageTracker.trackUsage({
        userId: userId || 'anonymous',
        serviceType: 'qwen3_embedding',
        modelName: 'Qwen/Qwen3-Embedding-0.6B',
        operation: 'generate_text_embedding',
        requestCount: 1,
        metadata: { textLength: productText.length, businessTemplate: input.businessTemplate }
      });

      return data.embeddings[0];
      
    } catch (error) {
      const processingTime = Date.now() - startTime;
      
      if (userId) {
        await this.aiUsageTracker.trackUsage({
          userId: userId || 'anonymous',
          serviceType: 'qwen3_embedding',
          modelName: 'Qwen/Qwen3-Embedding-0.6B',
          operation: 'generate_text_embedding_error',
          requestCount: 1,
          metadata: { error: error.message }
        });
      }

      this.logger.error('Failed to generate text embedding:', error);
      throw error;
    }
  }

  /**
   * Generate both image and text embeddings
   */
  async generateMultiModalEmbedding(input: MultiModalEmbeddingInput): Promise<EmbeddingResponse> {
    const result: EmbeddingResponse = {
      dimensions: {},
      models: {}
    };

    // Generate image embedding if provided
    if (input.image) {
      result.imageEmbedding = await this.generateImageEmbedding(input.image, input.userId);
      result.dimensions.image = result.imageEmbedding.length;
      result.models.image = 'google/siglip-large-patch16-384';
    }

    // Generate text embedding if provided
    if (input.text) {
      result.textEmbedding = await this.generateTextEmbedding(input.text, input.userId);
      result.dimensions.text = result.textEmbedding.length;
      result.models.text = 'Qwen/Qwen3-Embedding-0.6B';
    }

    // Create combined embedding if both are available
    if (result.imageEmbedding && result.textEmbedding) {
      result.combinedEmbedding = this.combineEmbeddings(
        result.imageEmbedding, 
        result.textEmbedding,
        0.6, // Image weight
        0.4  // Text weight
      );
      result.dimensions.combined = result.combinedEmbedding.length;
    }

    return result;
  }

  /**
   * Store product embeddings in database
   */
  async storeProductEmbedding(params: {
    productId: string;
    variantId: string;
    imageEmbedding?: number[];
    textEmbedding?: number[];
    combinedEmbedding?: number[];
    imageUrl?: string;
    imageHash?: string;
    productText: string;
    sourceType: string;
    sourceUrl?: string;
    businessTemplate?: string;
    scrapedData?: any;
    searchKeywords?: string[];
  }): Promise<void> {
    try {
      const supabase = this.supabaseService.getClient();

      const { error } = await supabase
        .from('ProductEmbeddings')
        .upsert({
          ProductId: params.productId,
          VariantId: params.variantId,
          ImageEmbedding: params.imageEmbedding,
          TextEmbedding: params.textEmbedding,
          CombinedEmbedding: params.combinedEmbedding,
          ImageUrl: params.imageUrl,
          ImageHash: params.imageHash,
          ProductText: params.productText,
          SourceType: params.sourceType,
          SourceUrl: params.sourceUrl,
          BusinessTemplate: params.businessTemplate,
          ScrapedData: params.scrapedData,
          SearchKeywords: params.searchKeywords,
          UpdatedAt: new Date().toISOString()
        });

      if (error) {
        this.logger.error('Failed to store product embedding:', error);
        throw error;
      }

      this.logger.log(`Stored embeddings for product ${params.productId}, variant ${params.variantId}`);
    } catch (error) {
      this.logger.error('Failed to store product embedding:', error);
      throw error;
    }
  }

  /**
   * Search similar products using multi-modal embeddings
   */
  async searchSimilarProducts(params: {
    imageEmbedding?: number[];
    textEmbedding?: number[];
    businessTemplate?: string;
    imageWeight?: number;
    textWeight?: number;
    limit?: number;
    threshold?: number;
  }): Promise<ProductMatch[]> {
    try {
      const supabase = this.supabaseService.getClient();

      // Use either image, text, or combined search based on available embeddings
      if (params.imageEmbedding && params.textEmbedding) {
        // Multi-modal search
        const { data, error } = await supabase.rpc('search_products_multimodal', {
          p_image_embedding: params.imageEmbedding,
          p_text_embedding: params.textEmbedding,
          p_business_template: params.businessTemplate,
          p_image_weight: params.imageWeight || 0.6,
          p_text_weight: params.textWeight || 0.4,
          p_limit: params.limit || 20,
          p_threshold: params.threshold || 0.5
        });

        if (error) throw error;
        return this.formatProductMatches(data);

      } else if (params.imageEmbedding) {
        // Image-only search
        return this.searchByImageEmbedding(params.imageEmbedding, params);

      } else if (params.textEmbedding) {
        // Text-only search
        return this.searchByTextEmbedding(params.textEmbedding, params);

      } else {
        throw new Error('At least one embedding (image or text) must be provided');
      }

    } catch (error) {
      this.logger.error('Failed to search similar products:', error);
      throw error;
    }
  }

  /**
   * Private helper methods
   */
  private async downloadImageAsBase64(imageUrl: string): Promise<string> {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to download image: ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    return Buffer.from(buffer).toString('base64');
  }

  private formatProductText(input: TextEmbeddingInput): string {
    const parts: string[] = [];
    
    parts.push(input.title);
    
    if (input.brand) parts.push(`Brand: ${input.brand}`);
    if (input.category) parts.push(`Category: ${input.category}`);
    if (input.price) parts.push(`Price: $${input.price}`);
    
    if (input.description) {
      const cleanDesc = input.description.replace(/\s+/g, ' ').trim();
      parts.push(cleanDesc.substring(0, 500));
    }
    
    if (input.tags && input.tags.length > 0) {
      parts.push(`Tags: ${input.tags.join(', ')}`);
    }
    
    return parts.join(' | ');
  }

  private buildTextInstruction(input: TextEmbeddingInput): string {
    const templateContext = input.businessTemplate ? ` in the ${input.businessTemplate} category` : '';
    const brandContext = input.brand ? ` from ${input.brand}` : '';
    
    return `Encode this ecommerce product${templateContext}${brandContext} for similarity search. Focus on product features, use cases, target audience, and comparable alternatives.`;
  }

  private combineEmbeddings(
    imageEmbedding: number[], 
    textEmbedding: number[], 
    imageWeight: number, 
    textWeight: number
  ): number[] {
    // Simple concatenation approach
    // In production, you might want to use learned combination weights
    const weightedImage = imageEmbedding.map(x => x * imageWeight);
    const weightedText = textEmbedding.map(x => x * textWeight);
    
    return [...weightedImage, ...weightedText];
  }

  private async searchByImageEmbedding(embedding: number[], params: any): Promise<ProductMatch[]> {
    const supabase = this.supabaseService.getClient();
    
    let query = supabase
      .from('ProductEmbeddings')
      .select(`
        ProductId, VariantId, ImageUrl, BusinessTemplate,
        ProductVariants!inner(Title, Description)
      `)
      .not('ImageEmbedding', 'is', null)
      .limit(params.limit || 20);

    if (params.businessTemplate) {
      query = query.eq('BusinessTemplate', params.businessTemplate);
    }

    const { data, error } = await query;
    if (error) throw error;

    // Calculate similarities manually (simplified)
    return data.map(item => ({
      productId: item.ProductId,
      variantId: item.VariantId,
      title: (item as any).ProductVariants?.Title || 'Unknown Product',
      description: (item as any).ProductVariants?.Description || '',
      imageUrl: item.ImageUrl,
      businessTemplate: item.BusinessTemplate,
      imageSimilarity: 0.8, // Placeholder - would calculate actual cosine similarity
      textSimilarity: 0,
      combinedScore: 0.8
    }));
  }

  private async searchByTextEmbedding(embedding: number[], params: any): Promise<ProductMatch[]> {
    // Similar to image search but for text embeddings
    const supabase = this.supabaseService.getClient();
    
    let query = supabase
      .from('ProductEmbeddings')
      .select(`
        ProductId, VariantId, ImageUrl, BusinessTemplate,
        ProductVariants!inner(Title, Description)
      `)
      .not('TextEmbedding', 'is', null)
      .limit(params.limit || 20);

    if (params.businessTemplate) {
      query = query.eq('BusinessTemplate', params.businessTemplate);
    }

    const { data, error } = await query;
    if (error) throw error;

    return data.map(item => ({
      productId: item.ProductId,
      variantId: item.VariantId,
      title: (item as any).ProductVariants?.Title || 'Unknown Product',
      description: (item as any).ProductVariants?.Description || '',
      imageUrl: item.ImageUrl,
      businessTemplate: item.BusinessTemplate,
      imageSimilarity: 0,
      textSimilarity: 0.8,
      combinedScore: 0.8
    }));
  }

  private formatProductMatches(rawData: any[]): ProductMatch[] {
    return rawData.map(item => ({
      productId: item.product_id,
      variantId: item.variant_id,
      title: item.title,
      description: item.description,
      imageUrl: item.image_url,
      businessTemplate: item.business_template,
      imageSimilarity: 1 - item.image_similarity, // Convert distance to similarity
      textSimilarity: 1 - item.text_similarity,
      combinedScore: 1 - item.combined_score
    }));
  }

  /**
   * Calculates the cosine similarity between two vectors.
   * Assumes vectors are normalized.
   */
  calculateEmbeddingSimilarity(vecA: number[], vecB: number[]): number {
    if (!vecA || !vecB || vecA.length !== vecB.length) {
      return 0;
    }

    let dotProduct = 0;
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
    }
    // For normalized vectors, the dot product is the cosine similarity.
    return dotProduct;
  }
} 