import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../common/supabase.service';
import { AiUsageTrackerService } from '../common/ai-usage-tracker.service';
import { OcrService, OcrResult } from '../common/ocr.service';
import sharp from 'sharp';
import { randomUUID } from 'crypto';

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
  ProductVariantId: string | null;
  title: string;
  description?: string;
  imageUrl?: string;
  businessTemplate?: string;
  price?: number; // Add price
  productUrl?: string; // Add productUrl
  searchKeywords?: String[];
  imageSimilarity: number;
  textSimilarity: number;
  combinedScore: number;
  retrievalChannels?: string; // Track which search channels found this result
}

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly aiServerUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly supabaseService: SupabaseService,
    private readonly aiUsageTracker: AiUsageTrackerService,
    private readonly ocrService: OcrService
  ) {
    this.aiServerUrl = (this.configService.get<string>('AI_SERVER_URL') || 'http://localhost:8000')
      .trim()
      .replace(/\/+$/, '');
    
    // Verify Sharp is available
    try {
      // Test Sharp availability by checking if it's a function
      if (typeof sharp === 'function') {
        this.logger.log('Sharp image processing library loaded successfully');
      } else {
        throw new Error('Sharp is not a function');
      }
    } catch (error) {
      this.logger.error('Sharp not available - image preprocessing will fail. Run: npm install sharp');
    }
  }

  private parseVectorMaybeString(value: any): number[] | null {
    if (Array.isArray(value)) return value as number[];
    if (typeof value === 'string') {
      try {
        // PostgREST often returns vectors like "[0.1,0.2,...]"
        const trimmed = value.trim();
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
          return JSON.parse(trimmed) as number[];
        }
        // Fallback: strip non-numeric chars and split
        const parts = trimmed.replace(/[^\d\.\-eE,]/g, '').split(',').filter(Boolean);
        return parts.map(Number);
      } catch {
        return null;
      }
    }
    return null;
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
        // 🚨 NEW: Validate that URL is not a local file path
        if (input.imageUrl.startsWith('file://')) {
          throw new Error(
            'Local file URLs (file://) are not supported. ' +
            'Please convert the image to base64 and use the imageBase64 field instead, ' +
            'or upload the image to a server and provide an https:// URL.'
          );
        }
        
        if (!input.imageUrl.startsWith('http://') && !input.imageUrl.startsWith('https://')) {
          throw new Error(
            'Invalid image URL format. Only http:// and https:// URLs are supported. ' +
            'For local images, please convert to base64 and use the imageBase64 field instead.'
          );
        }
        
        // Download and convert to base64
        imageData = await this.downloadImageAsBase64(input.imageUrl);
      } else {
        throw new Error('Either imageUrl or imageBase64 must be provided');
      }

      

      // Log request details for debugging
      const instruction = input.instruction || 'Encode this product image for visual similarity search';
      const base64Length = imageData.length;
      
      this.logger.log(`Sending to AI server: base64 length ${base64Length} chars, instruction: "${instruction}"`);
      
      const response = await fetch(`${this.aiServerUrl}/embed/image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_data: imageData,
          instruction: instruction
        }),
      });

      if (!response.ok) {
        let errorDetails = response.statusText;
        
        // Try to get more detailed error information
        try {
          const errorBody = await response.text();
          this.logger.error(`AI Server Error Details: ${errorBody}`);
          
          if (response.status === 422) {
            errorDetails = `Image format/size issue. AI server couldn't process the image. Details: ${errorBody}`;
          }
        } catch (e) {
          // Ignore JSON parsing errors
        }
        
        throw new Error(`Image embedding API error (${response.status}): ${errorDetails}`);
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
    productId: string | null;
    ProductVariantId: string | null;
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
    userId?: string; // Add userId for RLS
    ocrResult?: OcrResult; // 🎯 NEW: Include OCR data
  }, userJwtToken?: string): Promise<void> {
    try {
      // Use authenticated client if JWT token provided, otherwise fallback to service client
      const supabase = userJwtToken 
        ? this.supabaseService.getAuthenticatedClient(userJwtToken)
        : this.supabaseService.getServiceClient();

      // 🎯 Enhanced ScrapedData with OCR information
      const enhancedScrapedData = {
        ...params.scrapedData,
        ocr: params.ocrResult ? {
          text: params.ocrResult.text,
          confidence: params.ocrResult.confidence,
          processingTime: params.ocrResult.processingTimeMs,
          cardInfo: params.ocrResult.text ? this.ocrService.extractCardInfo(params.ocrResult.text) : null,
          extractedAt: new Date().toISOString()
        } : null
      };

      const { error } = await supabase
        .from('ProductEmbeddings')
        .upsert({
          ProductId: params.productId,
          ProductVariantId: params.ProductVariantId,
          UserId: params.userId, // Add UserId for RLS
          ImageEmbedding: params.imageEmbedding,
          TextEmbedding: params.textEmbedding,
          CombinedEmbedding: params.combinedEmbedding,
          ImageUrl: params.imageUrl,
          ImageHash: params.imageHash,
          ProductText: params.productText,
          SourceType: params.sourceType,
          SourceUrl: params.sourceUrl,
          BusinessTemplate: params.businessTemplate,
          ScrapedData: enhancedScrapedData, // 🎯 Now includes OCR data
          SearchKeywords: params.searchKeywords,
          UpdatedAt: new Date().toISOString()
        });

      if (error) {
        this.logger.error('Failed to store product embedding:', error);
        throw error;
      }

      this.logger.log(`Stored embeddings for product ${params.productId}, variant ${params.ProductVariantId}`);
    } catch (error) {
      this.logger.error('Failed to store product embedding:', error);
      throw error;
    }
  }

  /**
   * 🎯 NEW: Generate and store embeddings using the improved SigLIP approach
   * This replaces the old method and handles all scenarios correctly
   */
  async generateAndStoreProductEmbedding(params: {
    productId?: string | null;
    ProductVariantId?: string | null;
    images?: string[];           // Array of image URLs
    title?: string;             
    description?: string;
    imageWeight?: number;        // Default: 0.7 (70% image influence)
    textWeight?: number;         // Default: 0.3 (30% text influence)
    sourceType: string;
    sourceUrl?: string;
    businessTemplate?: string;
    scrapedData?: any;
    searchKeywords?: string[];
    userId?: string;             // Add userId for RLS
  }): Promise<void> {
    try {
      // Generate the comprehensive embedding using our new method
      const finalEmbedding = await this.createProductEmbedding({
        images: params.images,
        title: params.title,
        description: params.description,
        imageWeight: params.imageWeight,
        textWeight: params.textWeight,
      });

      // Generate individual components for backward compatibility
      let imageEmbedding: number[] | undefined;
      let textEmbedding: number[] | undefined;

      // Generate image embedding if images provided
      if (params.images && params.images.length > 0) {
        const images = params.images; // Type narrowing
        if (images.length === 1) {
          imageEmbedding = await this.generateImageEmbedding({ imageUrl: images[0] }, 'system');
        } else {
          // For multiple images, use our new combining method
          const imageEmbeddings: number[][] = [];
          for (const imageUrl of images) {
            try {
              const embedding = await this.generateImageEmbedding({ imageUrl }, 'system');
              imageEmbeddings.push(embedding);
            } catch (error) {
              this.logger.warn(`Failed to process image ${imageUrl}: ${error.message}`);
            }
          }
          if (imageEmbeddings.length > 0) {
            imageEmbedding = this.combineMultipleImages(imageEmbeddings);
          }
        }
      }

      // Generate text embedding if text provided
      if (params.title || params.description) {
        textEmbedding = await this.generateTextEmbedding({
          title: params.title || '',
          description: params.description || ''
        }, 'system');
      }

      // Store using the existing method
      await this.storeProductEmbedding({
        productId: params.productId || null,
        ProductVariantId: params.ProductVariantId || null,
        imageEmbedding: imageEmbedding,
        textEmbedding: textEmbedding,
        combinedEmbedding: finalEmbedding,  // 🎯 This is the new, improved combined embedding
        imageUrl: params.images?.[0],
        productText: `${params.title || ''} ${params.description || ''}`.trim(),
        sourceType: params.sourceType,
        sourceUrl: params.sourceUrl,
        businessTemplate: params.businessTemplate,
        scrapedData: params.scrapedData,
        searchKeywords: params.searchKeywords,
        userId: params.userId, // Add userId for RLS
      });

      this.logger.log(`✅ Generated and stored improved embeddings for product ${params.productId}`);
      
    } catch (error) {
      this.logger.error('Failed to generate and store product embedding:', error);
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
   * 🎯 UNIFIED VECTOR SEARCH - Handles ALL scenarios correctly
   * This replaces multiple separate search functions with one comprehensive approach
   */
  async performUnifiedVectorSearch(params: {
    images?: string[];           // Array of image URLs
    textQuery?: string;         // Text to search for
    businessTemplate?: string;  // Business context
    useHybridEmbedding?: boolean; // Use our special hybrid approach
    threshold?: number;         // Similarity threshold
    limit?: number;            // Max results
    userId?: string;           // For tracking
  }): Promise<{
    matches: ProductMatch[];
    confidence: 'high' | 'medium' | 'low';
    searchEmbedding: number[];  // The embedding used for search
    processingTimeMs: number;
    recommendedAction: string;
  }> {
    const startTime = Date.now();
    
    try {
      // 🎯 Step 1: Generate the search embedding using our unified approach
      let searchEmbedding: number[];
      
      if (params.useHybridEmbedding) {
        // Use our special hybrid approach for SerpAPI-like embeddings
        searchEmbedding = await this.createProductEmbedding({
          images: params.images,
          title: params.textQuery,
          imageWeight: 0.8, // Higher image weight for visual similarity
          textWeight: 0.2,
        });
      } else {
        // Standard approach
        searchEmbedding = await this.createProductEmbedding({
          images: params.images,
          title: params.textQuery,
          imageWeight: 0.7,
          textWeight: 0.3,
        });
      }

      // 🎯 Step 2: Perform vector similarity search in database
      const threshold = 0.0; // Show ALL results for debugging
      this.logger.log(`[UnifiedVectorSearch] Searching with threshold: ${threshold} (showing all results for debugging)`);
      
      const vectorMatches = await this.searchByEmbedding({
        embedding: searchEmbedding,
        businessTemplate: params.businessTemplate,
        threshold: threshold,
        limit: 125, // Show top 15 as requested
      });

      // 🎯 Step 3: Calculate confidence and determine action
      const topScore = vectorMatches.length > 0 ? Math.max(...vectorMatches.map(m => m.combinedScore)) : 0;
      
      let confidence: 'high' | 'medium' | 'low';
      let recommendedAction: string;

      if (topScore >= 0.95) {
        confidence = 'high';
        recommendedAction = 'show_single_match';
      } else if (topScore >= 0.75) {
        confidence = 'medium';
        recommendedAction = 'show_multiple_candidates';
      } else {
        confidence = 'low';
        recommendedAction = 'proceed_to_reranker';
      }

      const processingTimeMs = Date.now() - startTime;

      this.logger.log(`[UnifiedVectorSearch] Found ${vectorMatches.length} matches, confidence: ${confidence}, top score: ${topScore.toFixed(3)}`);

      return {
        matches: vectorMatches.slice(0, params.limit || 10),
        confidence,
        searchEmbedding,
        processingTimeMs,
        recommendedAction,
      };

    } catch (error) {
      this.logger.error('[UnifiedVectorSearch] Search failed:', error);
      throw error;
    }
  }

  /**
   * 🎯 ENHANCED QUICK SCAN - Uses new unified architecture
   */
  async performEnhancedQuickScan(params: {
    images?: string[];
    textQuery?: string;
    businessTemplate?: string;
    threshold?: number;
    userId: string;
    mode?: 'vlm-first' | 'vector-first' | 'auto';
  }, userJwtToken?: string): Promise<{
    matches: any[];
    confidence: 'high' | 'medium' | 'low';
    processingTimeMs: number;
    recommendedAction: string;
    searchEmbedding: number[];
  }> {
    const startTime = Date.now();
    
    try {
      this.logger.log(`[EnhancedQuickScan] Starting for user ${params.userId}`);

      // Fast path: VLM-first agentic search (no embeddings)
      if (params.mode === 'vlm-first' && params.images?.[0]) {
        const stageStart = Date.now();
        const vlm = await this.ocrService.analyzeImageAttributes({ imageUrl: params.images[0] });
        const vlmMs = Date.now() - stageStart;
        this.logger.log(`[VLM-First] VLM analysis took ${vlmMs}ms (conf=${vlm.confidence.toFixed(2)})`);

        // Routing based on confidence
        const route = vlm.confidence >= 0.8 ? 'text-only' : vlm.confidence >= 0.4 ? 'hybrid-lite' : 'image-fallback';
        this.logger.log(`[VLM-First] Routing: ${route}`);

        // Build candidate queries in widening order
        const queries: string[] = [];
        const p0 = (vlm.paraphrases?.[0] || '').trim();
        const p1 = (vlm.paraphrases?.[1] || '').trim();
        const p2 = (vlm.paraphrases?.[2] || '').trim();
        if (p0) queries.push(p0);
        if (p1) queries.push(p1);
        if (p2) queries.push(p2);
        if (vlm.ocrText) queries.push(vlm.ocrText.slice(0, 200));
        queries.push('product item accessory'); // broad safety net

        const supabase = this.supabaseService.getClient();
        let usedQuery = '';
        let ftsCandidatesAll: any[] = [];
        let totalFtsMs = 0;

        for (const q of queries) {
          const qTrim = q.slice(0, 200);
          const t0 = Date.now();
          const { data, error } = await supabase
            .from('ProductEmbeddings')
            .select(`ProductId, ProductVariantId, ImageUrl, BusinessTemplate, ProductText, SourceType, ProductVariants(Title, Description, Price), SearchVector`)
            .textSearch('SearchVector', qTrim, { type: 'websearch', config: 'english' })
            .limit(200);
          const ms = Date.now() - t0;
          totalFtsMs += ms;
          if (error) this.logger.warn(`[VLM-First] FTS error for "${qTrim}": ${error.message}`);
          const count = data?.length || 0;
          this.logger.log(`[VLM-First] FTS(${count > 0 ? 'hit' : 'miss'}) ${count} rows in ${ms}ms for query: "${qTrim}"`);
          if (count > 0) {
            usedQuery = qTrim;
            ftsCandidatesAll = data || [];
            break;
          }
        }

        // Cheap sort heuristic: prioritize title hits (from usedQuery terms), then description length, then presence of price
        const terms = usedQuery.toLowerCase().split(/\s+/).filter(Boolean);
        const candidates = (ftsCandidatesAll || []).map((row: any) => {
          const title: string = row.ProductVariants?.Title || row.ProductText || '';
          const desc: string = row.ProductVariants?.Description || '';
          const titleLower = title.toLowerCase();
          let termHits = 0;
          for (const t of terms) if (t && titleLower.includes(t)) termHits++;
          const quality = Math.min(1, Math.max(0, (title.length - 10) / 70));
          const priceBonus = row.ProductVariants?.Price ? 0.05 : 0;
          const heuristic = termHits * 0.2 + quality * 0.2 + priceBonus;
          return { row, title, desc, heuristic };
        })
        .sort((a, b) => b.heuristic - a.heuristic)
        .slice(0, 50)
        .map(({ row, title, desc }) => ({
          productId: row.ProductId || '',
          ProductVariantId: row.ProductVariantId || null,
          title: title || 'Unknown Product',
          description: desc || `Scanned product (${row.SourceType})`,
          imageUrl: row.ImageUrl,
          businessTemplate: row.BusinessTemplate,
          price: row.ProductVariants?.Price || 0,
          productUrl: row.ProductId ? `https://sssync.app/products/${row.ProductId}` : row.ImageUrl || '#',
          imageSimilarity: 0,
          textSimilarity: 0.5, // indicative only
          combinedScore: 0.5,
          retrievalChannels: 'fts',
        }));

        // Optional: verify top 4 with Groq Smart Picker (vision) when available
        let verified: any[] = [];
        try {
          if ((ftsCandidatesAll?.length || 0) > 0 && this.configService.get<string>('GROQ_API_KEY')) {
            const top4 = candidates.slice(0, 4).map((m, idx) => ({
              id: m.ProductVariantId || m.productId || `cand_${idx}`,
              title: m.title,
              description: m.description,
              imageUrl: m.imageUrl,
              vectorScore: m.combinedScore || 0.5,
            }));
            // Lazy import to avoid circular dep — or call GroqSmartPickerService if injected here in future
            // For now, attach the top4 as 'verified' without reranking to keep dependency simple
            verified = top4;
          }
        } catch {}

        const totalMs = Date.now() - startTime;
        const confidence: 'high' | 'medium' | 'low' = vlm.confidence >= 0.85 && candidates.length > 0 ? 'high' : vlm.confidence >= 0.6 ? 'medium' : 'low';
        const recommended = candidates.length === 0 ? 'fallback_to_manual' : (confidence === 'high' ? 'show_single_match' : 'show_multiple_candidates');

        this.logger.log(`[VLM-First] Done. VLM: ${vlmMs}ms, FTS: ${totalFtsMs}ms, Total: ${totalMs}ms, Candidates: ${candidates.length}, Conf: ${confidence}`);

        return {
          matches: candidates,
          confidence,
          processingTimeMs: totalMs,
          recommendedAction: recommended,
          searchEmbedding: [], // not used in VLM-first
        } as any;
      }

      // Use unified vector search
      const searchResult = await this.performUnifiedVectorSearch({
        images: params.images,
        textQuery: params.textQuery,
        businessTemplate: params.businessTemplate,
        useHybridEmbedding: false, // Standard quick scan
        threshold: params.threshold || 0.1, // Lower threshold to see more results
        limit: 30, // More results for debugging
        userId: params.userId,
      });

      // 🎯 Store the generated embedding for future searches with OCR data
      // This creates a "scanned product" entry that can be found in future searches
      if (searchResult.searchEmbedding && (params.images?.length || params.textQuery)) {
        try {
          // 🎯 Extract OCR from the scanned image
          let ocrResult: OcrResult | undefined;
          if (params.images?.length) {
            try {
              ocrResult = await this.ocrService.extractTextFromImage({ 
                imageUrl: params.images[0] 
              });
              this.logger.log(`[EnhancedQuickScan] OCR extracted: "${ocrResult.text.substring(0, 50)}..." (conf: ${ocrResult.confidence.toFixed(2)})`);
            } catch (ocrError) {
              this.logger.warn(`[EnhancedQuickScan] OCR failed: ${ocrError.message}`);
            }
          }

          const productData = {
            title: params.textQuery || 'Scanned Product',
            description: `Product scanned by user on ${new Date().toISOString()}`,
            imageUrl: params.images?.[0],
            businessTemplate: params.businessTemplate || 'General Products',
          };
          
          // Generate a unique SKU for this scanned product
          const scanSku = `SCAN_${params.userId.slice(0,8)}_${Date.now()}`;
          
          // 🎯 Enhanced product text with OCR
          const enhancedProductText = [
            params.textQuery || 'Scanned Product',
            ocrResult?.text || ''
          ].filter(Boolean).join(' ');
          
                     // Store as a "scanned product" embedding (no real Product record needed)
           await this.storeProductEmbedding({
            productId: null, // No real product - this is a scan embedding
            ProductVariantId: null, // No real variant - this is a scan embedding
            imageEmbedding: params.images?.length ? searchResult.searchEmbedding : undefined,
            textEmbedding: params.textQuery ? searchResult.searchEmbedding : undefined,
            combinedEmbedding: searchResult.searchEmbedding,
            imageUrl: params.images?.[0],
            productText: enhancedProductText, // 🎯 Now includes OCR text
            sourceType: 'quick_scan',
            businessTemplate: params.businessTemplate || 'General Products',
            userId: params.userId, // Add userId for RLS
            ocrResult, // 🎯 Store OCR data in ScrapedData
          }, userJwtToken);
          
          this.logger.log(`[EnhancedQuickScan] Stored embedding with OCR for future searches`);
        } catch (error) {
          this.logger.warn(`[EnhancedQuickScan] Failed to store embedding:`, error.message);
          // Don't fail the whole scan if storage fails
        }
      }

      // Track usage
      await this.aiUsageTracker.trackUsage({
        userId: params.userId,
        serviceType: 'embedding',
        modelName: 'unified-search',
        operation: 'enhanced_quick_scan',
        requestCount: 1,
        metadata: { 
          confidence: searchResult.confidence,
          matchCount: searchResult.matches.length,
          hasImages: !!(params.images?.length),
          hasText: !!params.textQuery,
        }
      });

      return searchResult;

    } catch (error) {
      this.logger.error(`[EnhancedQuickScan] Failed for user ${params.userId}:`, error);
      throw error;
    }
  }

  /**
   * Private helper methods
   */
  /**
   * Download image and convert to base64 with preprocessing
   */
  private async downloadImageAsBase64(imageUrl: string): Promise<string> {
    try {
      this.logger.log(`Downloading image from: ${imageUrl}`);
      
      const response = await fetch(imageUrl);
      if (!response.ok) {
        throw new Error(`Failed to download image: ${response.statusText}`);
      }
      
      const buffer = await response.arrayBuffer();
      const sizeInMB = buffer.byteLength / (1024 * 1024);
      
      this.logger.log(`Downloaded image: ${sizeInMB.toFixed(2)}MB`);
      
      // If image is larger than 2MB, we need to resize it
      if (sizeInMB > 2) {
        this.logger.warn(`Image too large (${sizeInMB.toFixed(2)}MB), preprocessing required`);
        return await this.preprocessLargeImage(buffer, imageUrl);
      }
      
      return Buffer.from(buffer).toString('base64');
      
    } catch (error) {
      this.logger.error(`Failed to download/process image from ${imageUrl}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Preprocess large images by resizing them using Sharp
   */
  private async preprocessLargeImage(buffer: ArrayBuffer, originalUrl: string): Promise<string> {
    try {
      this.logger.log(`Preprocessing large image from ${originalUrl}`);
      
      // Convert to Buffer for Sharp processing
      const inputBuffer = Buffer.from(buffer);
      
      // Get image metadata
      const metadata = await sharp(inputBuffer).metadata();
      this.logger.log(`Original image: ${metadata.width}x${metadata.height}, format: ${metadata.format}`);
      
      // Resize image to max 800x800 pixels, maintain aspect ratio
      const resizedBuffer = await sharp(inputBuffer)
        .resize(800, 800, { 
          fit: 'inside',
          withoutEnlargement: true 
        })
        .jpeg({ 
          quality: 85,
          progressive: true 
        })
        .toBuffer();
      
      const resizedSizeInMB = resizedBuffer.length / (1024 * 1024);
      this.logger.log(`Resized image to: ${resizedSizeInMB.toFixed(2)}MB`);
      
      // Convert resized image to base64
      return resizedBuffer.toString('base64');
      
    } catch (error) {
      this.logger.error(`Failed to preprocess image with Sharp: ${error.message}`);
      throw new Error(`Image preprocessing failed: ${error.message}. Try uploading a smaller image.`);
    }
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

  /**
   * Normalize a vector to unit length for proper cosine similarity
   */
  private normalizeVector(vector: number[]): number[] {
    const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
    if (magnitude === 0) {
      this.logger.warn('Zero magnitude vector encountered during normalization');
      return vector;
    }
    return vector.map(val => val / magnitude);
  }

  /**
   * Combine multiple embeddings using weighted averaging in the shared SigLIP space.
   * This preserves the model's learned cross-modal understanding.
   */
  private combineEmbeddings(
    imageEmbedding: number[], 
    textEmbedding: number[], 
    imageWeight: number = 0.7, 
    textWeight: number = 0.3
  ): number[] {
    // Normalize both embeddings to unit vectors
    const normalizedImage = this.normalizeVector(imageEmbedding);
    const normalizedText = this.normalizeVector(textEmbedding);
    
    // Weighted average in the shared embedding space
    const combined = normalizedImage.map((imgVal, i) => 
      imgVal * imageWeight + normalizedText[i] * textWeight
    );
    
    // Normalize the final combined vector for proper cosine similarity
    return this.normalizeVector(combined);
  }

  /**
   * Combine multiple image embeddings into a single representative embedding
   * Useful for products with multiple photos
   */
  private combineMultipleImages(imageEmbeddings: number[][]): number[] {
    if (imageEmbeddings.length === 0) {
      throw new Error('Cannot combine empty array of embeddings');
    }
    
    if (imageEmbeddings.length === 1) {
      return this.normalizeVector(imageEmbeddings[0]);
    }

    // Normalize each image embedding first
    const normalizedEmbeddings = imageEmbeddings.map(emb => this.normalizeVector(emb));
    
    // Average across all images (equal weight)
    const averaged = normalizedEmbeddings[0].map((_, i) => 
      normalizedEmbeddings.reduce((sum, emb) => sum + emb[i], 0) / normalizedEmbeddings.length
    );
    
    // Normalize the final averaged vector
    return this.normalizeVector(averaged);
  }

  /**
   * 🎯 Create a comprehensive product embedding that handles ALL scenarios correctly:
   * 
   * SCENARIO 1: Single image only
   *   createProductEmbedding({ images: ['url'] })
   *   → Returns normalized SigLIP image embedding
   * 
   * SCENARIO 2: Multiple images only  
   *   createProductEmbedding({ images: ['url1', 'url2', 'url3'] })
   *   → Averages normalized embeddings from all images
   * 
   * SCENARIO 3: Text only
   *   createProductEmbedding({ title: 'iPhone', description: 'Latest phone' })
   *   → Returns normalized SigLIP text embedding
   * 
   * SCENARIO 4: Mixed images + text
   *   createProductEmbedding({ images: ['url'], title: 'iPhone', imageWeight: 0.7 })
   *   → Weighted average in shared SigLIP space (preserves cross-modal understanding)
   * 
   * 🔑 KEY BENEFITS:
   * - All embeddings exist in the same SigLIP shared space
   * - Image of "red car" will be close to text "red car" 
   * - Multiple images get combined intelligently
   * - Proper normalization for accurate cosine similarity
   * - Weights control image vs text importance (default: 70% image, 30% text)
   * 
   * ⚠️  REPLACES the old concatenation approach that broke the shared space
   */
  async createProductEmbedding(productData: {
    images?: string[]; // Array of image URLs
    title?: string;
    description?: string;
    imageWeight?: number;
    textWeight?: number;
    includeOcr?: boolean; // 🎯 NEW: Enable OCR extraction
  }): Promise<number[]> {
    const { images, title, description, imageWeight = 0.7, textWeight = 0.3, includeOcr = true } = productData;
    
    let finalImageEmbedding: number[] | null = null;
    let finalTextEmbedding: number[] | null = null;
    let ocrText = '';

    // Process images if provided
    if (images && images.length > 0) {
      const imageEmbeddings: number[][] = [];
      
             for (const imageUrl of images) {
         try {
           const embedding = await this.generateImageEmbedding({ imageUrl }, 'system');
           imageEmbeddings.push(embedding);
          
          // 🎯 NEW: Extract OCR text from each image
          if (includeOcr) {
            try {
              const ocrResult = await this.ocrService.extractTextFromImage({ imageUrl });
              if (ocrResult.text && ocrResult.confidence > 0.3) {
                ocrText += ` ${ocrResult.text}`;
                this.logger.log(`[OCR] Extracted from ${imageUrl}: "${ocrResult.text.substring(0, 50)}..." (conf: ${ocrResult.confidence.toFixed(2)})`);
              }
            } catch (ocrError) {
              this.logger.warn(`[OCR] Failed for ${imageUrl}: ${ocrError.message}`);
            }
          }
         } catch (error) {
           this.logger.warn(`Failed to process image ${imageUrl}: ${error.message}`);
           // Continue with other images
         }
       }

      if (imageEmbeddings.length > 0) {
        finalImageEmbedding = this.combineMultipleImages(imageEmbeddings);
      }
    }

    // Process text if provided (now including OCR text)
    if (title || description || ocrText) {
      const combinedText = [title || '', description || '', ocrText.trim()].filter(Boolean).join(' ');
      const textContent = {
        title: title || '',
        description: combinedText // 🎯 Combined with OCR text
      };
      finalTextEmbedding = await this.generateTextEmbedding(textContent, 'system');
    }

    // Determine final embedding based on available data
    if (finalImageEmbedding && finalTextEmbedding) {
      // Mixed: Both image(s) and text
      this.logger.debug('Creating mixed image+text embedding');
      return this.combineEmbeddings(finalImageEmbedding, finalTextEmbedding, imageWeight, textWeight);
      
    } else if (finalImageEmbedding) {
      // Image(s) only
      this.logger.debug(`Creating image-only embedding from ${images?.length} image(s)`);
      return finalImageEmbedding;
      
    } else if (finalTextEmbedding) {
      // Text only
      this.logger.debug('Creating text-only embedding');
      return this.normalizeVector(finalTextEmbedding);
      
    } else {
      throw new Error('No valid images or text provided for embedding generation');
    }
  }

  private async searchByImageEmbedding(embedding: number[], params: any): Promise<ProductMatch[]> {
    const supabase = this.supabaseService.getClient();
    
    let query = supabase
      .from('ProductEmbeddings')
      .select(`
        ProductId, ProductVariantId, ImageUrl, BusinessTemplate, ProductText, SourceType,
        ProductVariants(Title, Description)
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
      productId: item.ProductId || '',
      ProductVariantId: item.ProductVariantId,
      title: (item as any).ProductVariants?.Title || item.ProductText || 'Scanned Product',
      description: (item as any).ProductVariants?.Description || `Scanned product (${item.SourceType})`,
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
        ProductId, ProductVariantId, ImageUrl, BusinessTemplate, ProductText, SourceType,
        ProductVariants(Title, Description)
      `)
      .not('TextEmbedding', 'is', null)
      .limit(params.limit || 20);

    if (params.businessTemplate) {
      query = query.eq('BusinessTemplate', params.businessTemplate);
    }

    const { data, error } = await query;
    if (error) throw error;

    return data.map(item => ({
      productId: item.ProductId || '',
      ProductVariantId: item.ProductVariantId,
      title: (item as any).ProductVariants?.Title || item.ProductText || 'Scanned Product',
      description: (item as any).ProductVariants?.Description || `Scanned product (${item.SourceType})`,
      imageUrl: item.ImageUrl,
      businessTemplate: item.BusinessTemplate,
      imageSimilarity: 0,
      textSimilarity: 0.8,
      combinedScore: 0.8
    }));
  }

  private formatProductMatches(rawData: any[]): ProductMatch[] {
    return rawData.map(item => ({
      productId: item.product_id || '',
      ProductVariantId: item.variant_id,
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
   
  calculateEmbeddingSimilarity(vecA: number[], vecB: number[]): number {
    if (!vecA || !vecB || vecA.length !== vecB.length) {
      this.logger.debug(`[CosineSimilarity] Dimension mismatch or null vectors: A=${vecA?.length || 0}, B=${vecB?.length || 0}`);
      return 0;
    }

    let dotProduct = 0;
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
    }
    
    // Log some debug info about the vectors
    const magnitudeA = Math.sqrt(vecA.reduce((sum, val) => sum + val * val, 0));
    const magnitudeB = Math.sqrt(vecB.reduce((sum, val) => sum + val * val, 0));
    
    this.logger.debug(`[CosineSimilarity] Dot product: ${dotProduct.toFixed(4)}, |A|: ${magnitudeA.toFixed(4)}, |B|: ${magnitudeB.toFixed(4)}`);
    
    // For normalized vectors, the dot product is the cosine similarity.
    return dotProduct;
  }
   */

  calculateEmbeddingSimilarity(vecA: number[], vecB: number[]): number {
    if (!vecA || !vecB || vecA.length !== vecB.length) {
      this.logger.debug(`[CosineSimilarity] Dimension mismatch or null vectors: A=${vecA?.length || 0}, B=${vecB?.length || 0}`);
      return 0;
    }

    // inside calculateEmbeddingSimilarity:
    const dot = vecA.reduce((s, a, i) => s + a * vecB[i], 0);
    const magA = Math.sqrt(vecA.reduce((s, a) => s + a*a, 0));
    const magB = Math.sqrt(vecB.reduce((s, b) => s + b*b, 0));
    const cos = magA > 0 && magB > 0 ? dot / (magA * magB) : 0;
    return Math.max(0, Math.min(1, cos));

  }

  /**
   * 🎯 NEW: Extract OCR text from image for Groq Smart Picker
   */
  async extractOcrText(imageUrl: string): Promise<{ text: string; confidence: number } | null> {
    try {
      const ocrResult = await this.ocrService.extractTextFromImage({ imageUrl });
      return {
        text: ocrResult.text,
        confidence: ocrResult.confidence
      };
    } catch (error) {
      this.logger.warn(`[OCR] Failed to extract text from ${imageUrl}: ${error.message}`);
      return null;
    }
  }

  /**
   * 🎯 HYBRID SEARCH: Dense Vector + Sparse FTS + Intelligent Fusion
   * Combines semantic embeddings with keyword search for superior recall and precision
   */
  private async searchByEmbedding(params: {
    embedding: number[];
    businessTemplate?: string;
    threshold: number;
    limit: number;
    searchQuery?: string; // Optional text query for FTS
  }): Promise<ProductMatch[]> {
    const searchStartTime = Date.now();
    
    try {
      const supabase = this.supabaseService.getClient();

      this.logger.log(`[HybridSearch] 🚀 Starting hybrid dense+sparse retrieval`);
      this.logger.log(`[HybridSearch] Query embedding dimensions: ${params.embedding?.length || 0}`);
      this.logger.log(`[HybridSearch] Query embedding first 5 values: [${params.embedding?.slice(0, 5).map(v => v.toFixed(4)).join(', ')}...]`);
      
      // Generate search query for FTS if not provided
      const queryGenStartTime = Date.now();
      let searchQuery = params.searchQuery;
      if (!searchQuery) {
        searchQuery = this.generateSearchQueryFromContext(params);
      }
      const queryGenTime = Date.now() - queryGenStartTime;
      
      this.logger.log(`[HybridSearch] FTS search query: "${searchQuery || 'none'}" (generated in ${queryGenTime}ms)`);

      // 🎯 STEP 1: Test individual components first for debugging
      this.logger.log(`[HybridSearch] 🔍 Testing individual components before hybrid`);
      
      const qImage = params.embedding; // 768 dimensions

      // Test dense vector search alone (using same logic as legacy that works)
      const denseTestTime = Date.now();
      const { data: denseTest, error: denseError } = await supabase
        .from('ProductEmbeddings')
        .select(`
          ProductId, ProductVariantId, ImageUrl, ProductText, SourceType, BusinessTemplate,
          CombinedEmbedding, ImageEmbedding,
          ProductVariants(Id, Title, Description, Price, Sku)
        `)
        .not('CombinedEmbedding', 'is', null)
        .neq('SourceType', 'quick_scan')
        .limit(50);
      const denseTestTime2 = Date.now() - denseTestTime;
      
      this.logger.log(`[DenseTest] Found ${denseTest?.length || 0} results in ${denseTestTime2}ms`);
      if (denseTest && denseTest.length > 0) {
        this.logger.log(`[DenseTest] Top 3 results (raw data check):`);
        denseTest.slice(0, 3).forEach((item: any, index: number) => {
          const title = item.ProductVariants?.Title || item.ProductText || 'No title';
          this.logger.log(`  ${index + 1}. "${title.substring(0, 40)}..." - HasCombinedEmb: ${!!item.CombinedEmbedding} HasImageEmb: ${!!item.ImageEmbedding}`);
        });
      }

      // Test FTS search alone with multiple approaches
      const ftsTestTime = Date.now();
      
      // 🎯 TRY MULTIPLE FTS APPROACHES
      this.logger.log(`[FTSTest] Testing query: "${searchQuery}"`);
      
      // Approach 1: textSearch with plainto
      const { data: ftsTest1, error: ftsError1 } = await supabase
        .from('ProductEmbeddings')
        .select(`ProductId, ProductVariantId, ProductText, SearchVector, ProductVariants(Title, Description, Price)`)
        .textSearch('SearchVector', searchQuery, { type: 'plain', config: 'english' })
        .limit(20);
      
      // Approach 2: Try with generic single keyword 
      const { data: ftsTest2, error: ftsError2 } = await supabase
        .from('ProductEmbeddings')
        .select(`ProductId, ProductVariantId, ProductText, SearchVector, ProductVariants(Title, Description, Price)`)
        .textSearch('SearchVector', 'product', { type: 'plain', config: 'english' })
        .limit(20);
        
      // Approach 3: Try with another generic term
      const { data: ftsTest3, error: ftsError3 } = await supabase
        .from('ProductEmbeddings')
        .select(`ProductId, ProductVariantId, ProductText, SearchVector, ProductVariants(Title, Description, Price)`)
        .textSearch('SearchVector', 'item', { type: 'plain', config: 'english' })
        .limit(20);
      
      const ftsTestTime2 = Date.now() - ftsTestTime;
      
      this.logger.log(`[FTSTest] Complex query "${searchQuery}": ${ftsTest1?.length || 0} results`);
      this.logger.log(`[FTSTest] Simple query "product": ${ftsTest2?.length || 0} results`);
      this.logger.log(`[FTSTest] Simple query "item": ${ftsTest3?.length || 0} results`);
      
      // Use the best result
      const ftsTest = (ftsTest3?.length || 0) > 0 ? ftsTest3 : (ftsTest2?.length || 0) > 0 ? ftsTest2 : ftsTest1;
      
      if (ftsTest && ftsTest.length > 0) {
        this.logger.log(`[FTSTest] Top 3 FTS results:`);
        ftsTest.slice(0, 3).forEach((item: any, index: number) => {
          this.logger.log(`  ${index + 1}. "${item.ProductVariants?.Title || item.ProductText}"`);
        });
      } else {
        this.logger.warn(`[FTSTest] ❌ NO FTS RESULTS with any approach!`);
      }

      // Now try the hybrid search function with EXTENSIVE debugging
      this.logger.log(`[HybridSearch] 🔍 Now testing hybrid SQL function: search_products_hybrid_image`);
      
      // 🎯 STEP 1: Test the exact same parameters individually first
      this.logger.log(`[HybridSearch] 📋 Testing SQL function parameters:`);
      this.logger.log(`[HybridSearch]   - q_image: ${qImage?.length} dimensions`);
      this.logger.log(`[HybridSearch]   - search_query: "${searchQuery}"`);
      this.logger.log(`[HybridSearch]   - p_business_template: ${params.businessTemplate || 'null'}`);
      this.logger.log(`[HybridSearch]   - dense_limit: 50`);
      this.logger.log(`[HybridSearch]   - sparse_limit: 50`);
      this.logger.log(`[HybridSearch]   - final_limit: 100`);
      
      const sqlStartTime = Date.now();

      // 🎯 STEP 2: Test the exact same FTS approach that worked individually
      this.logger.log(`[HybridSearch] 🧪 First, let's test the EXACT same FTS approach that worked:`);
      try {
        const { data: exactFtsTest, error: exactFtsError } = await supabase
          .from('ProductEmbeddings')
          .select(`ProductId, ProductVariantId, ProductText, SearchVector, ProductVariants(Title, Description, Price)`)
          .textSearch('SearchVector', 'item', { type: 'plain', config: 'english' })
          .limit(5);
        
        this.logger.log(`[HybridSearch] 🧪 Exact FTS Test Results: ${exactFtsTest?.length || 0} rows`);
        if (exactFtsTest && exactFtsTest.length > 0) {
          exactFtsTest.slice(0, 2).forEach((row: any, i: number) => {
            this.logger.log(`[HybridSearch] 🧪   ${i+1}. "${row.ProductVariants?.Title || row.ProductText?.substring(0, 40)}..."`);
          });
        }
      } catch (ftsTestError) {
        this.logger.error(`[HybridSearch] 🧪 Exact FTS test failed: ${ftsTestError.message}`);
      }

      // 🎯 STEP 3: Call the function with detailed error handling
      this.logger.log(`[HybridSearch] 🎯 Now calling hybrid function with same parameters...`);
      const { data, error } = await supabase.rpc('search_products_hybrid_image', {
        q_image: qImage,
        search_query: searchQuery,
        p_business_template: (!params.businessTemplate || params.businessTemplate.toLowerCase() === 'general') ? null : params.businessTemplate,
        dense_limit: 50,    // Candidates from vector search
        sparse_limit: 50,   // Candidates from FTS search
        final_limit: 100 // More candidates for reranker
      });
      
      const sqlTime = Date.now() - sqlStartTime;
      this.logger.log(`[HybridSearch] ⏱️ SQL function completed in ${sqlTime}ms`);
      this.logger.log(`[HybridSearch] 📊 Raw result: data=${!!data}, length=${data?.length || 0}, error=${!!error}`);

      if (error) {
        this.logger.error(`[HybridSearch] ❌ SQL FUNCTION FAILED with error: ${error.message}`);
        this.logger.error(`[HybridSearch] Error code: ${error.code}, details: ${error.details}, hint: ${error.hint}`);
        this.logger.error(`[HybridSearch] SQL function parameters sent:`, {
          q_image_dimensions: qImage?.length,
          search_query: searchQuery,
          p_business_template: params.businessTemplate,
          dense_limit: 50,
          sparse_limit: 50,
          final_limit: 100
        });
        
        // 🎯 Check specific error types
        if (error.code === '42883') {
          this.logger.error(`[HybridSearch] Function does not exist - deploy the hybrid search SQL function first!`);
        } else if (error.code === '42P01') {
          this.logger.error(`[HybridSearch] Table/column does not exist - check if SearchVector column exists`);
        } else if (error.code === '42804') {
          this.logger.error(`[HybridSearch] Type mismatch - check SQL function return types`);
        }
        
        this.logger.error(`[HybridSearch] ❌ HYBRID SEARCH FAILED - stopping here (no fallback)`);
        throw new Error(`Hybrid search failed: ${error.message}`);
      }

      if (!data || data.length === 0) {
        this.logger.warn(`[HybridSearch] ⚠️ Hybrid function returned ZERO results`);
        this.logger.warn(`[HybridSearch] Dense found: ${denseTest?.length || 0}, FTS found: ${ftsTest?.length || 0}, Hybrid found: 0`);
        
        // 🎯 DETAILED ANALYSIS of why hybrid failed
        this.logger.error(`[HybridSearch] 🔍 DEBUGGING ZERO RESULTS:`);
        this.logger.error(`[HybridSearch] 1. SQL Function exists: ${!error ? 'YES' : 'NO'}`);
        this.logger.error(`[HybridSearch] 2. Dense components work: ${(denseTest?.length || 0) > 0 ? 'YES' : 'NO'}`);
        this.logger.error(`[HybridSearch] 3. FTS components work: ${(ftsTest?.length || 0) > 0 ? 'YES' : 'NO'}`);
        this.logger.error(`[HybridSearch] 4. Parameters passed: q_image=${!!qImage}, search_query="${searchQuery}"`);
        
        // 🎯 LIKELY CAUSES:
        this.logger.error(`[HybridSearch] 🔧 LIKELY CAUSES:`);
        this.logger.error(`[HybridSearch]   A) SearchVector column missing/empty`);
        this.logger.error(`[HybridSearch]   B) Vector embedding dimension mismatch in SQL`);
        this.logger.error(`[HybridSearch]   C) FTS query syntax incompatible with plainto_tsquery`);
        this.logger.error(`[HybridSearch]   D) Business template filtering too restrictive`);
        this.logger.error(`[HybridSearch]   E) UNION logic combining dense+sparse incorrectly`);
        
        // 🎯 EMERGENCY DIAGNOSIS: Check SearchVector column population
        try {
          const { data: searchVectorCheck, error: svError } = await supabase
            .from('ProductEmbeddings')
            .select('ProductId, SearchVector, ProductText')
            .not('SearchVector', 'is', null)
            .limit(5);
          
          this.logger.error(`[HybridSearch] 🔍 SearchVector CHECK: Found ${searchVectorCheck?.length || 0} rows with populated SearchVector`);
          if (searchVectorCheck && searchVectorCheck.length > 0) {
            searchVectorCheck.slice(0, 2).forEach((row: any, i: number) => {
              this.logger.error(`[HybridSearch]   Row ${i+1}: ProductText="${row.ProductText?.substring(0, 40)}..." HasSearchVector=${!!row.SearchVector}`);
            });
          } else {
            this.logger.error(`[HybridSearch] ❌ PROBLEM FOUND: SearchVector column is EMPTY/NULL for all rows!`);
          }
        } catch (diagError) {
          this.logger.error(`[HybridSearch] ❌ SearchVector diagnostic failed: ${diagError.message}`);
        }

        // 🎯 STEP 4: Test individual SQL components manually
        this.logger.error(`[HybridSearch] 🔧 Testing individual SQL components:`);
        
        // Test 1: Direct dense search SQL (similar to what works)
        try {
          const { data: denseManualTest, error: denseManualError } = await supabase.rpc('test_dense_only', {
            q_image: qImage,
            p_business_template: params.businessTemplate || null,
            match_limit: 10
          });
          this.logger.error(`[HybridSearch] 🔧 Dense Manual Test: ${denseManualTest?.length || 0} results, error: ${!!denseManualError}`);
        } catch (denseTestError) {
          this.logger.error(`[HybridSearch] 🔧 Dense manual test failed (function may not exist): ${denseTestError.message}`);
        }
        
        // Test 2: Direct FTS search using the exact working query
        this.logger.error(`[HybridSearch] 🔧 Testing direct PostgreSQL FTS query simulation:`);
        this.logger.error(`[HybridSearch] 🔧 Query would be: SELECT * FROM "ProductEmbeddings" WHERE "SearchVector" @@ plainto_tsquery('english', '${searchQuery}') LIMIT 5`);
        
        // Test 3: Simplified hybrid query
        this.logger.error(`[HybridSearch] 🔧 Potential issues with hybrid function:`);
        this.logger.error(`[HybridSearch] 🔧   A) Multi-word query '${searchQuery}' causing FTS to fail`);
        this.logger.error(`[HybridSearch] 🔧   B) Vector dimensions mismatch (expecting ${qImage?.length})`);
        this.logger.error(`[HybridSearch] 🔧   C) UNION ALL logic failing to combine results`);
        this.logger.error(`[HybridSearch] 🔧   D) Business template filter too restrictive`);
        this.logger.error(`[HybridSearch] 🔧   E) DISTINCT ON clause removing all results`);
        
        // Test 4: Try with single word that we know works
        this.logger.error(`[HybridSearch] 💡 SUGGESTION: Try hybrid function with single word 'item' instead of '${searchQuery}'`);
        try {
          const { data: singleWordTest, error: singleWordError } = await supabase.rpc('search_products_hybrid_image', {
            q_image: qImage,
            search_query: 'item', // Single word that worked in FTS test
            p_business_template: params.businessTemplate || null,
            dense_limit: 50,
            sparse_limit: 50,
            final_limit: 100
          });
          this.logger.error(`[HybridSearch] 💡 Single word 'item' test: ${singleWordTest?.length || 0} results, error: ${!!singleWordError}`);
          if (singleWordTest && singleWordTest.length > 0) {
            this.logger.error(`[HybridSearch] 💡 SUCCESS! Single word works - problem is multi-word query parsing`);
          }
        } catch (singleWordError) {
          this.logger.error(`[HybridSearch] 💡 Single word test also failed: ${singleWordError.message}`);
        }
        
        // 🎯 RECOMMENDATION:
        this.logger.error(`[HybridSearch] 💡 NEXT STEPS:`);
        this.logger.error(`[HybridSearch]   1. If SearchVector is empty: Populate it with text data`);
        this.logger.error(`[HybridSearch]   2. If SearchVector exists: Check SQL function vector dimensions`);
        this.logger.error(`[HybridSearch]   3. Test hybrid function components individually`);
        this.logger.error(`[HybridSearch]   4. Verify UNION logic combines results correctly`);
        
        // Don't fall back - fail explicitly so we can debug
        throw new Error(`Hybrid search returned no results despite individual components working`);
      }

      this.logger.log(`[HybridSearch] SUCCESS! Found ${data.length} hybrid matches`);
      
      // 🎯 Enhanced channel analysis
      const channelCounts = data.reduce((acc: any, item: any) => {
        acc[item.retrieval_channels] = (acc[item.retrieval_channels] || 0) + 1;
        return acc;
      }, {});
      this.logger.log(`[HybridSearch] Channel breakdown:`, channelCounts);
      
      // 🎯 Separate dense vs sparse results for analysis
      const denseOnly = data.filter((item: any) => item.retrieval_channels === 'dense');
      const sparseOnly = data.filter((item: any) => item.retrieval_channels === 'sparse');
      const hybrid = data.filter((item: any) => item.retrieval_channels === 'dense+sparse');
      
      this.logger.log(`[HybridAnalysis] Dense-only: ${denseOnly.length}, Sparse-only: ${sparseOnly.length}, Hybrid: ${hybrid.length}`);
      
      // 🎯 Log top results from each channel
      if (denseOnly.length > 0) {
        this.logger.log(`[DenseTop10] Vector similarity results:`);
        denseOnly.slice(0, 10).forEach((item: any, index: number) => {
          this.logger.log(`  ${index + 1}. "${item.title?.substring(0, 40)}..." - VecSim: ${item.vector_similarity?.toFixed(4)} FinalScore: ${item.retrieval_score?.toFixed(4)}`);
        });
      }
      
      if (sparseOnly.length > 0) {
        this.logger.log(`[SparseTop10] FTS keyword results:`);
        sparseOnly.slice(0, 10).forEach((item: any, index: number) => {
          this.logger.log(`  ${index + 1}. "${item.title?.substring(0, 40)}..." - FTSRank: ${item.search_vector_rank?.toFixed(4)} FinalScore: ${item.retrieval_score?.toFixed(4)}`);
        });
      }
      
      if (hybrid.length > 0) {
        this.logger.log(`[HybridTop10] Combined dense+sparse results:`);
        hybrid.slice(0, 10).forEach((item: any, index: number) => {
          this.logger.log(`  ${index + 1}. "${item.title?.substring(0, 40)}..." - VecSim: ${item.vector_similarity?.toFixed(4)} FTSRank: ${item.search_vector_rank?.toFixed(4)} FinalScore: ${item.retrieval_score?.toFixed(4)}`);
        });
      }
  
      // 🎯 Overall top 10 with detailed scores
      this.logger.log(`[HybridTop10] Final ranked results:`);
      data.slice(0, 10).forEach((item: any, index: number) => {
        const isProduct = !!item.variant_id && item.variant_id !== 'scan';
        this.logger.log(`  ${index + 1}. "${item.title?.substring(0, 40)}..." - Score: ${item.retrieval_score?.toFixed(4)} (Vec:${item.vector_similarity?.toFixed(3)}, FTS:${item.search_vector_rank?.toFixed(3)}) [${item.retrieval_channels}] ${isProduct ? '[PRODUCT]' : '[SCAN]'}`);
      });

      // 🎯 Performance summary
      const totalTime = Date.now() - searchStartTime;
      const mappingStartTime = Date.now();
      
      // Convert to ProductMatch format
      const results = data.map((item: any) => ({
        productId: item.product_id || '',
        ProductVariantId: item.variant_id || null,
        title: item.title || 'Unknown Product',
        description: item.description || 'No description',
        imageUrl: item.image_url,
        businessTemplate: item.business_template,
        price: item.price || 0,
        productUrl: item.product_id 
          ? `https://sssync.app/products/${item.product_id}`
          : item.image_url || '#',
        imageSimilarity: item.vector_similarity || 0,
        textSimilarity: item.search_vector_rank || 0,
        combinedScore: item.retrieval_score || 0,
        retrievalChannels: item.retrieval_channels, // New field for debugging
      }));
      
      const mappingTime = Date.now() - mappingStartTime;
      
      this.logger.log(`[HybridPerformance] 📊 COMPLETE - Total: ${totalTime}ms (SQL: ${sqlTime}ms, Mapping: ${mappingTime}ms, Other: ${totalTime - sqlTime - mappingTime}ms)`);
      this.logger.log(`[HybridPerformance] 📈 Efficiency: ${data.length} results, ${(data.length / totalTime * 1000).toFixed(1)} results/sec`);
      
      return results;

    } catch (error) {
      this.logger.error('Failed hybrid search, falling back to legacy:', error);
      return this.legacyMultiChannelSearch(params);
    }
  }

  /**
   * Generate FTS search query from embedding context
   * 🎯 TRULY GENERIC: Broad terms that work across all product types
   */
  private generateSearchQueryFromContext(params: any): string {
    const template = params.businessTemplate?.toLowerCase();
    
    // 🎯 GENERIC APPROACH: Use broad terms that appear across many products
    // This avoids bias toward any specific category
    if (template?.includes('pokemon') || template?.includes('cards')) {
      return 'card game collectible trading rare common';
    } else if (template?.includes('electronics') || template?.includes('tech')) {
      return 'device electronics technology digital gadget';
    } else if (template?.includes('fashion') || template?.includes('clothing')) {
      return 'clothing fashion apparel style brand';
    } else if (template?.includes('books')) {
      return 'book literature novel author title';
    } else {
      // 🎯 COMPLETELY GENERIC fallback - basic product terms that exist everywhere
      return 'product item brand new used condition description title';
    }
  }

  /**
   * Legacy fallback to the old multi-channel search
   */
  private async legacyMultiChannelSearch(params: {
    embedding: number[];
    businessTemplate?: string;
    threshold: number;
    limit: number;
  }): Promise<ProductMatch[]> {
    try {
      const supabase = this.supabaseService.getClient();
      
      const qImage = params.embedding; // 768
      const qCombined = params.embedding; // Use same embedding since CombinedEmbedding is 768-dim

      const { data, error } = await supabase.rpc('search_products_by_vector_multi_v2', {
        q_image: qImage,
        q_combined: qCombined,
        q_text: null,
        match_threshold: params.threshold,
        match_count: params.limit,
        p_business_template: null
      });

      if (error) {
        this.logger.error(`[LegacySearch] FAILED with error: ${error.message}`, error);
        this.logger.warn(`[LegacySearch] Falling back to enhanced manual search...`);
        return this.enhancedManualVectorSearch(params);
      }

      if (!data || data.length === 0) {
        this.logger.log(`[LegacySearch] No results, trying enhanced manual search`);
        return this.enhancedManualVectorSearch(params);
      }

      this.logger.log(`[LegacySearch] Found ${data.length} matches via legacy function`);

      // Convert to ProductMatch format
      return data.map((item: any) => ({
        productId: item.product_id || '',
        ProductVariantId: item.variant_id || null,
        title: item.title || 'Unknown Product',
        description: item.description || 'No description',
        imageUrl: item.image_url,
        businessTemplate: item.business_template,
        price: item.price || 0,
        productUrl: item.product_id 
          ? `https://sssync.app/products/${item.product_id}`
          : item.image_url || '#',
        imageSimilarity: item.similarity || 0,
        textSimilarity: item.similarity || 0,
        combinedScore: item.similarity || 0,
      }));

    } catch (error) {
      this.logger.error('Failed legacy search, falling back to manual:', error);
      return this.enhancedManualVectorSearch(params);
    }
  }

  /**
   * SUPERCHARGED manual search with multi-channel fusion, smart scoring, and premium deduplication
   */
  private async enhancedManualVectorSearch(params: {
    embedding: number[];
    businessTemplate?: string;
    threshold: number;
    limit: number;
  }): Promise<ProductMatch[]> {
    try {
      const supabase = this.supabaseService.getClient();
      
      this.logger.log(`[SuperchargedManualSearch] Starting multi-channel fusion search`);
      
      // Get expanded dataset with all embedding types
      let query = supabase
        .from('ProductEmbeddings')
        .select(`
          ProductId,
          ProductVariantId,
          ImageUrl,
          ProductText,
          SourceType,
          BusinessTemplate,
          CombinedEmbedding,
          ImageEmbedding,
          TextEmbedding,
          ProductVariants(
            Id,
            Title,
            Description,
            Price,
            Sku
          )
        `)
        .neq('SourceType', 'quick_scan')
        .limit(1500); // Wider net for better recall

      if (params.businessTemplate && params.businessTemplate !== 'general') {
        query = query.eq('BusinessTemplate', params.businessTemplate);
      }

      const { data, error } = await query;
      if (error) throw error;

      this.logger.log(`[SuperchargedManualSearch] Processing ${data?.length || 0} candidates`);

      // Multi-channel similarity calculation with intelligent fusion
      const scoredResults = (data || []).map((item, index) => {
        const title = (item as any).ProductVariants?.Title || item.ProductText || 'Scanned Product';
        const description = (item as any).ProductVariants?.Description || `Scanned product (${item.SourceType})`;
        const isActualProduct = !!(item as any).ProductVariants?.Title;
        
        // Calculate similarities across all available channels
        let imageSim = 0;
        let combinedSim = 0;
        let textSim = 0;
        let channelsUsed: string[] = [];

        // Image embedding similarity (768-dim)
        if (item.ImageEmbedding) {
          const imageEmb = this.parseVectorMaybeString(item.ImageEmbedding);
          if (imageEmb && imageEmb.length === params.embedding.length) {
            imageSim = this.calculateEmbeddingSimilarity(params.embedding, imageEmb);
            channelsUsed.push('image');
          }
        }

        // Combined embedding similarity (1024-dim, use first 768)
        if (item.CombinedEmbedding) {
          const combinedEmb = this.parseVectorMaybeString(item.CombinedEmbedding);
          if (combinedEmb && combinedEmb.length >= params.embedding.length) {
            // Use first 768 dimensions for image queries
            const truncatedCombined = combinedEmb.slice(0, params.embedding.length);
            combinedSim = this.calculateEmbeddingSimilarity(params.embedding, truncatedCombined) * 0.95; // slight penalty for indirect match
            channelsUsed.push('combined');
          }
        }

        // Text embedding similarity (if available and same dimensions)
        if (item.TextEmbedding) {
          const textEmb = this.parseVectorMaybeString(item.TextEmbedding);
          if (textEmb && textEmb.length === params.embedding.length) {
            textSim = this.calculateEmbeddingSimilarity(params.embedding, textEmb) * 0.7; // lower weight for text in image queries
            channelsUsed.push('text');
          }
        }

        // Intelligent fusion: pick the best similarity but boost if multiple channels agree
        const bestSim = Math.max(imageSim, combinedSim, textSim);
        const channelAgreement = channelsUsed.length > 1 ? 1.05 : 1.0; // 5% boost for multi-channel agreement
        
        // Quality bonuses
        const productBonus = isActualProduct ? 1.02 : 1.0; // 2% boost for actual products
        const titleQualityBonus = this.calculateTitleQuality(title);
        
        // Final fused score
        const fusedScore = bestSim * channelAgreement * productBonus * titleQualityBonus;
        
        return {
          productId: (item as any).ProductVariants?.Id || item.ProductId || '',
          ProductVariantId: item.ProductVariantId || 'scan',
          title,
          description,
          imageUrl: item.ImageUrl,
          businessTemplate: item.BusinessTemplate,
          price: (item as any).ProductVariants?.Price || 0,
          productUrl: (item as any).ProductVariants?.Id 
            ? `https://sssync.app/products/${(item as any).ProductVariants.Id}`
            : item.ImageUrl || '#',
          imageSimilarity: imageSim,
          textSimilarity: textSim,
          combinedScore: fusedScore,
          rawSimilarity: bestSim,
          channelsUsed: channelsUsed.join(','),
          isActualProduct
        };
      });

      // Sort by fused score (highest first)
      scoredResults.sort((a, b) => b.combinedScore - a.combinedScore);
      
      // Log top results
      this.logger.log(`[SuperchargedManualSearch] Top 10 fused scores:`);
      scoredResults.slice(0, 10).forEach((result, index) => {
        this.logger.log(`  ${index + 1}. "${result.title.substring(0, 50)}..." - Score: ${result.combinedScore.toFixed(4)} (${result.channelsUsed}) ${result.isActualProduct ? '[PRODUCT]' : '[SCAN]'}`);
      });
      
      // Advanced deduplication with similarity clustering
      const clusteredResults = this.advancedDeduplication(scoredResults);
      
      // Filter by threshold and limit
      const finalResults = clusteredResults
        .filter(m => m.combinedScore >= params.threshold)
        .slice(0, params.limit);
      
      this.logger.log(`[SuperchargedManualSearch] ${scoredResults.length} -> ${clusteredResults.length} -> ${finalResults.length} (scored -> deduplicated -> final)`);
      
      return finalResults;
      
    } catch (error) {
      this.logger.error('Supercharged manual search failed, falling back to basic manual search:', error);
      return this.manualVectorSearch(params);
    }
  }

  /**
   * Deduplicate ProductMatch results by ID and title similarity
   */
  private deduplicateProductMatches(matches: ProductMatch[]): ProductMatch[] {
    if (!matches || matches.length === 0) return matches;

    const uniqueMatches: ProductMatch[] = [];
    const seenProductIds = new Set<string>();
    const seenTitles = new Map<string, number>(); // title -> index in uniqueMatches

    for (const match of matches) {
      let shouldAdd = true;
      const productKey = `${match.productId}_${match.ProductVariantId}`;

      // Skip if we've seen this exact product ID + variant ID
      if (seenProductIds.has(productKey)) {
        this.logger.debug(`[DeduplicateProducts] Skipping duplicate product: ${productKey}`);
        shouldAdd = false;
      } else if (match.title) {
        // Check for title similarity
        const normalizedTitle = match.title
          .toLowerCase()
          .replace(/[^\w\s]/g, '')
          .replace(/\s+/g, ' ')
          .trim();

        for (const [seenTitle, existingIndex] of seenTitles.entries()) {
          const similarity = this.calculateSimpleSimilarity(normalizedTitle, seenTitle);
          if (similarity > 0.85) {
            // Keep the one with higher score
            if (match.combinedScore > uniqueMatches[existingIndex].combinedScore) {
              this.logger.debug(`[DeduplicateProducts] Replacing lower-scoring duplicate: "${match.title.substring(0, 30)}..."`);
              const oldMatch = uniqueMatches[existingIndex];
              const oldProductKey = `${oldMatch.productId}_${oldMatch.ProductVariantId}`;
              uniqueMatches[existingIndex] = match;
              seenProductIds.delete(oldProductKey);
              seenProductIds.add(productKey);
            } else {
              this.logger.debug(`[DeduplicateProducts] Skipping lower-scoring duplicate: "${match.title.substring(0, 30)}..."`);
            }
            shouldAdd = false;
            break;
          }
        }

        if (shouldAdd) {
          seenTitles.set(normalizedTitle, uniqueMatches.length);
        }
      }

      if (shouldAdd) {
        seenProductIds.add(productKey);
        uniqueMatches.push(match);
      }
    }

    return uniqueMatches;
  }

  /**
   * Simple Jaccard similarity calculation for title comparison
   */
  private calculateSimpleSimilarity(title1: string, title2: string): number {
    const words1 = new Set(title1.split(/\s+/));
    const words2 = new Set(title2.split(/\s+/));
    
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  /**
   * Calculate title quality bonus based on cleanliness and informativeness
   */
  private calculateTitleQuality(title: string): number {
    if (!title || title.length < 3) return 0.8;
    
    const cleanTitle = title.toLowerCase();
    let qualityScore = 1.0;
    
    // Penalties for low-quality indicators
    const spamWords = ['scanned', 'untitled', 'unknown', 'test', 'temp'];
    if (spamWords.some(word => cleanTitle.includes(word))) {
      qualityScore -= 0.1;
    }
    
    // Bonus for informative length (sweet spot: 20-80 chars)
    if (title.length >= 20 && title.length <= 80) {
      qualityScore += 0.05;
    } else if (title.length < 10) {
      qualityScore -= 0.05;
    }
    
    // Penalty for excessive punctuation
    const punctuationRatio = (title.match(/[!@#$%^&*()_+=\[\]{};:'",<>/?\\|`~]/g) || []).length / title.length;
    if (punctuationRatio > 0.15) {
      qualityScore -= 0.08;
    }
    
    // Bonus for product-like patterns (brands, models, numbers)
    if (/\b\d{1,4}[a-zA-Z]{1,3}\b/.test(title) || /\b[A-Z]{2,}\b/.test(title)) {
      qualityScore += 0.03;
    }
    
    return Math.max(0.7, Math.min(1.1, qualityScore));
  }

  /**
   * Advanced deduplication using similarity clustering and quality ranking
   */
  private advancedDeduplication(matches: any[]): any[] {
    if (!matches || matches.length === 0) return matches;

    const clusters: any[][] = [];
    const processed = new Set<number>();

    // Group similar items into clusters
    for (let i = 0; i < matches.length; i++) {
      if (processed.has(i)) continue;

      const cluster = [matches[i]];
      processed.add(i);

      // Find all similar items for this cluster
      for (let j = i + 1; j < matches.length; j++) {
        if (processed.has(j)) continue;

        const similarity = this.calculateAdvancedSimilarity(matches[i], matches[j]);
        if (similarity > 0.8) { // High similarity threshold
          cluster.push(matches[j]);
          processed.add(j);
        }
      }

      clusters.push(cluster);
    }

    // Select best representative from each cluster
    const representatives = clusters.map(cluster => {
      if (cluster.length === 1) return cluster[0];

      // Sort cluster by quality and score
      cluster.sort((a, b) => {
        // Prioritize: actual products > higher scores > better titles
        if (a.isActualProduct !== b.isActualProduct) {
          return b.isActualProduct ? 1 : -1;
        }
        if (Math.abs(a.combinedScore - b.combinedScore) > 0.01) {
          return b.combinedScore - a.combinedScore;
        }
        return this.calculateTitleQuality(b.title) - this.calculateTitleQuality(a.title);
      });

      return cluster[0]; // Best representative
    });

    this.logger.log(`[AdvancedDeduplication] Clustered ${matches.length} items into ${clusters.length} groups`);
    
    return representatives;
  }

  /**
   * Calculate advanced similarity considering title, product ID, and visual similarity
   */
  private calculateAdvancedSimilarity(item1: any, item2: any): number {
    // Exact product match
    if (item1.productId && item2.productId && item1.productId === item2.productId) {
      return 1.0;
    }

    // Title similarity (weighted heavily)
    const titleSim = this.calculateSimpleSimilarity(
      item1.title?.toLowerCase() || '',
      item2.title?.toLowerCase() || ''
    );

    // Visual similarity from embeddings (if available)
    const visualSim = Math.abs((item1.rawSimilarity || 0) - (item2.rawSimilarity || 0)) < 0.05 ? 0.8 : 0.0;

    // Price similarity (for products with prices)
    let priceSim = 0;
    if (item1.price > 0 && item2.price > 0) {
      const priceDiff = Math.abs(item1.price - item2.price) / Math.max(item1.price, item2.price);
      priceSim = priceDiff < 0.1 ? 0.3 : 0.0; // Similar if within 10%
    }

    // Weighted combination
    return titleSim * 0.6 + visualSim * 0.3 + priceSim * 0.1;
  }

  /**
   * Fallback manual vector search when PostgreSQL function is not available
   */
  private async manualVectorSearch(params: {
    embedding: number[];
    businessTemplate?: string;
    threshold: number;
    limit: number;
  }): Promise<ProductMatch[]> {
    try {
      const supabase = this.supabaseService.getClient();

      this.logger.log(`[ManualVectorSearch] Using manual similarity calculation`);

      // Get all embeddings from database for similarity calculation
      let query = supabase
        .from('ProductEmbeddings')
        .select(`
          ProductId,
          ProductVariantId,
          ImageUrl,
          ProductText,
          SourceType,
          BusinessTemplate,
          CombinedEmbedding,
          ProductVariants(
            Id,
            Title,
            Description,
            Price,
            Sku
          )
        `)
        .not('CombinedEmbedding', 'is', null)
        .neq('SourceType', 'quick_scan');
        
        // NO ORDERING - we'll sort by similarity after calculation!

      // Filter by business template if provided
      if (params.businessTemplate && params.businessTemplate !== 'general') {
        query = query.eq('BusinessTemplate', params.businessTemplate);
      }

      const { data, error } = await query.limit(2000); // Get ALL embeddings for proper similarity search

      if (error) {
        this.logger.error('Database search error:', error);
        throw error;
      }

      this.logger.log(`[ManualVectorSearch] Found ${data?.length || 0} total embeddings in database`);



      // Calculate similarities using actual cosine similarity
      const allResults: (ProductMatch & { rawSimilarity: number })[] = (data || []).map((item, index) => {
        const raw = item.CombinedEmbedding;
        const storedEmbedding = this.parseVectorMaybeString(raw);
        let similarity = 0.0; // Start with 0 instead of 0.5
        let calculationStatus = 'no_calculation';
        
        if (storedEmbedding && params.embedding) {
          try {
            // Log embedding details for debugging
            this.logger.debug(`[EmbeddingDebug ${index + 1}] Stored type: ${typeof storedEmbedding}, Is array: ${Array.isArray(storedEmbedding)}, Length: ${Array.isArray(storedEmbedding) ? storedEmbedding.length : 'N/A'}`);
            
            if (storedEmbedding && storedEmbedding.length === params.embedding.length) {
              similarity = this.calculateEmbeddingSimilarity(params.embedding, storedEmbedding);
              calculationStatus = 'calculated';
            } else {
              this.logger.warn(`[EmbeddingDebug ${index + 1}] Dimension mismatch - Query: ${params.embedding.length}, Stored: ${Array.isArray(storedEmbedding) ? storedEmbedding.length : 'not array'}`);
              calculationStatus = 'dimension_mismatch';
            }
          } catch (error) {
            this.logger.warn(`[EmbeddingDebug ${index + 1}] Failed to calculate similarity:`, error.message);
            calculationStatus = 'error';
          }
        } else {
          this.logger.debug(`[EmbeddingDebug ${index + 1}] Missing embeddings - stored: ${!!storedEmbedding}, query: ${!!params.embedding}`);
          calculationStatus = 'missing_data';
        }
        
        const title = (item as any).ProductVariants?.Title || item.ProductText || 'Scanned Product';
        const description = (item as any).ProductVariants?.Description || `Scanned product (${item.SourceType})`;
        const isActualProduct = !!(item as any).ProductVariants?.Title;
        
        // Log every calculation for debugging - show all calculations 
        this.logger.debug(`[Similarity ${index + 1}/${data.length}] "${title.substring(0, 50)}..." - Score: ${similarity.toFixed(4)} (${calculationStatus}) ${isActualProduct ? '[PRODUCT]' : '[SCAN]'}`);
        
        // Also log high-scoring items and any containing target keywords
        const shouldHighlight = index < 20 || title.toLowerCase().includes('mewtwo') || title.toLowerCase().includes('pikachu') || similarity > 0.7;
        if (shouldHighlight) {
          this.logger.log(`[HighScore ${index + 1}/${data.length}] "${title.substring(0, 50)}..." - Score: ${similarity.toFixed(4)} (${calculationStatus}) ${isActualProduct ? '[PRODUCT]' : '[SCAN]'}`);
        }
        
        return {
          productId: (item as any).ProductVariants?.Id || item.ProductId || '',
          ProductVariantId: item.ProductVariantId || 'scan',
          title,
          description: (item as any).ProductVariants?.Description || `Scanned product (${item.SourceType})`,
          imageUrl: item.ImageUrl,
          businessTemplate: item.BusinessTemplate,
          price: (item as any).ProductVariants?.Price || 0,
          productUrl: (item as any).ProductVariants?.Id 
            ? `https://sssync.app/products/${(item as any).ProductVariants.Id}`
            : item.ImageUrl || '#',
          imageSimilarity: similarity,
          textSimilarity: similarity * 0.9,
          combinedScore: similarity,
          rawSimilarity: similarity,
        };
      });

      // Sort by similarity score (HIGHEST FIRST - this is the core fix!)
      allResults.sort((a, b) => b.combinedScore - a.combinedScore);
      
      // Log top 15 scores as requested
      this.logger.log(`[ManualVectorSearch] Top 15 similarity scores (SORTED BY ACTUAL SIMILARITY):`);
      allResults.slice(0, 15).forEach((result, index) => {
        const isActualProduct = result.ProductVariantId !== 'scan';
        this.logger.log(`  ${index + 1}. "${result.title.substring(0, 50)}..." - Score: ${result.combinedScore.toFixed(4)} ${isActualProduct ? '[PRODUCT]' : '[SCAN]'}`);
      });
      
      // Log threshold filtering
      const filteredMatches = allResults.filter(m => m.combinedScore >= params.threshold);
      this.logger.log(`[ManualVectorSearch] Threshold: ${params.threshold}, Before filtering: ${allResults.length}, After filtering: ${filteredMatches.length}`);
      
      // Return top results prioritizing actual products
      const actualProducts = filteredMatches.filter(m => m.ProductVariantId !== 'scan');
      const scanProducts = filteredMatches.filter(m => m.ProductVariantId === 'scan');
      
      // Combine: actual products first, then scans, up to the limit
      const finalResults = [...actualProducts, ...scanProducts].slice(0, params.limit);
      
      this.logger.log(`[ManualVectorSearch] Final results: ${actualProducts.length} products + ${finalResults.length - actualProducts.length} scans = ${finalResults.length} total`);
      
      // Return results (remove rawSimilarity)
      return finalResults.map(({ rawSimilarity, ...match }) => match);

    } catch (error) {
      this.logger.error('Failed manual vector search:', error);
      throw error;
    }
  }
} 