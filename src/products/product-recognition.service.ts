import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmbeddingService, ProductMatch } from '../embedding/embedding.service';
import { RerankerService, RerankerCandidate, RerankerResponse } from '../embedding/reranker.service';
import { FirecrawlService } from './firecrawl.service';
import { VectorSearchService } from '../embedding/vector-search.service';
import { SupabaseService } from '../common/supabase.service';
import { AiUsageTrackerService } from '../common/ai-usage-tracker.service';

export interface ProductRecognitionRequest {
  imageUrl?: string;
  imageBase64?: string;
  textQuery?: string;
  userId: string;
  businessTemplate?: string;
  platformConnections?: string[];
}

// NEW: This is the definitive structure for a product candidate returned to the frontend.
export interface ProductCandidate {
  id: string; // The database ID (e.g., variantId) if it's an internal match
  title: string;
  description?: string;
  imageUrl?: string;
  price?: number;
  source: 'internal' | 'web' | 'marketplace';
  similarity: number; // The final reranked score (0.0 to 1.0)
  visualSimilarity?: number; // Optional: raw visual score
  textSimilarity?: number; // Optional: raw text score
  url?: string; // The source URL if found on the web
  metadata?: any; // For any other useful data
}

// REVISED: This is the primary contract with the frontend.
export interface RecognitionResult {
  confidence: 'high' | 'medium' | 'low';
  systemAction: 'show_single_match' | 'show_multiple_candidates' | 'fallback_to_external' | 'fallback_to_manual';
  rankedCandidates: ProductCandidate[];
  processingSteps: string[];
  userMessage: string; // Add back for final response
  userInstructions: string; // Add back for final response
  metadata: {
  processingTimeMs: number;
    modelsUsed: string[];
    matchId?: string; // For feedback logging
    // Deprecating the direct exposure of embeddings and raw results to the frontend
    // imageEmbedding?: number[];
    // textEmbedding?: number[];
    imageEmbedding?: number[]; // Add imageEmbedding to metadata
    textEmbedding?: number[]; // Add textEmbedding to metadata
  };
}

export interface BusinessTemplateConfig {
  name: string;
  searchKeywords: string[];
  embeddingInstructions: {
    image: string;
    text: string;
  };
  rerankerContext: string;
  fallbackSources: string[];
  confidenceThresholds: {
    high: number;
    medium: number;
  };
}

@Injectable()
export class ProductRecognitionService {
  private readonly logger = new Logger(ProductRecognitionService.name);
  
  // Business template configurations
  private readonly businessTemplates: Map<string, BusinessTemplateConfig> = new Map([
    ['comic-book', {
      name: 'Comic Book',
      searchKeywords: ['comic', 'graphic novel', 'manga', 'superhero', 'DC', 'Marvel'],
      embeddingInstructions: {
        image: 'Encode this comic book cover focusing on character design, art style, series, publisher, and visual elements that distinguish different comic issues.',
        text: 'Encode this comic book focusing on series name, issue number, character names, publisher, story arcs, and collectibility factors.'
      },
      rerankerContext: 'comic book and graphic novel marketplace',
      fallbackSources: ['mycomicshop.com', 'midtowncomics.com', 'dccomics.com', 'marvel.com'],
      confidenceThresholds: { high: 0.92, medium: 0.65 }
    }],
    ['electronics', {
      name: 'Electronics',
      searchKeywords: ['electronics', 'gadget', 'device', 'tech', 'smartphone', 'laptop'],
      embeddingInstructions: {
        image: 'Encode this electronic device focusing on form factor, brand logos, model design, ports, buttons, and distinctive visual features.',
        text: 'Encode this electronic product focusing on brand, model number, technical specifications, features, and compatibility.'
      },
      rerankerContext: 'electronics and technology marketplace',
      fallbackSources: ['amazon.com', 'bestbuy.com', 'newegg.com', 'bhphotovideo.com'],
      confidenceThresholds: { high: 0.95, medium: 0.70 }
    }],
    ['fashion', {
      name: 'Fashion & Apparel',
      searchKeywords: ['clothing', 'apparel', 'fashion', 'shoes', 'accessories', 'style'],
      embeddingInstructions: {
        image: 'Encode this fashion item focusing on style, color, pattern, fabric texture, brand elements, and design details that distinguish similar items.',
        text: 'Encode this fashion product focusing on brand, style name, size, color, material, season, and target demographic.'
      },
      rerankerContext: 'fashion and apparel marketplace',
      fallbackSources: ['amazon.com', 'zappos.com', 'nordstrom.com', 'asos.com'],
      confidenceThresholds: { high: 0.88, medium: 0.60 }
    }],
    ['amazon', {
      name: 'Amazon',
      searchKeywords: ['amazon', 'marketplace', 'e-commerce'],
      embeddingInstructions: {
        image: 'Encode this product image for Amazon, focusing on details that would appear in a product listing.',
        text: 'Encode this product text for Amazon, focusing on title, brand, and key features to find it on the marketplace.'
      },
      rerankerContext: 'a general e-commerce marketplace like Amazon',
      fallbackSources: ['amazon.com'],
      confidenceThresholds: { high: 0.95, medium: 0.70 }
    }],
    ['ebay', {
      name: 'eBay',
      searchKeywords: ['ebay', 'auction', 'marketplace', 'second-hand'],
      embeddingInstructions: {
        image: 'Encode this product image for eBay, focusing on condition, unique identifiers, and listing-style photography.',
        text: 'Encode this product text for eBay, focusing on title, brand, condition, and keywords used in auction listings.'
      },
      rerankerContext: 'an auction and second-hand marketplace like eBay',
      fallbackSources: ['ebay.com'],
      confidenceThresholds: { high: 0.90, medium: 0.65 }
    }],
    ['depop', {
      name: 'Depop',
      searchKeywords: ['depop', 'fashion', 'vintage', 'streetwear', 'second-hand clothing'],
      embeddingInstructions: {
        image: 'Encode this fashion item for Depop, focusing on unique style, brand, era, and visual elements common in social commerce listings.',
        text: 'Encode this clothing item text for Depop, focusing on brand, style, size, condition, and descriptive tags used in social marketplaces.'
      },
      rerankerContext: 'a social fashion marketplace like Depop',
      fallbackSources: ['depop.com'],
      confidenceThresholds: { high: 0.88, medium: 0.60 }
    }],
    ['previewsworld', {
        name: 'Previews World',
        searchKeywords: ['previews world', 'comic distribution', 'diamond comics'],
        embeddingInstructions: {
          image: 'Encode this comic book or collectible cover/image, focusing on character art, logos, and trade dress for catalog identification.',
          text: 'Encode this comic or collectible text, focusing on series title, issue number, publisher, and creator names for catalog search.'
        },
        rerankerContext: 'a comic book distributor catalog like Previews World',
        fallbackSources: ['previewsworld.com'],
        confidenceThresholds: { high: 0.92, medium: 0.65 }
    }]
  ]);

  constructor(
    private readonly configService: ConfigService,
    private readonly embeddingService: EmbeddingService,
    private readonly rerankerService: RerankerService,
    private readonly firecrawlService: FirecrawlService,
    private readonly vectorSearchService: VectorSearchService,
    private readonly supabaseService: SupabaseService,
    private readonly aiUsageTracker: AiUsageTrackerService
  ) {}

  /**
   * Main product recognition pipeline
   */
  async recognizeProduct(request: ProductRecognitionRequest): Promise<RecognitionResult> {
    const startTime = Date.now();
    const processingSteps: string[] = [];
    const result: RecognitionResult = {
      confidence: 'low',
      systemAction: 'fallback_to_external',
      rankedCandidates: [],
      processingSteps,
      userMessage: '', // Initialize
      userInstructions: '', // Initialize
      metadata: {
      processingTimeMs: 0,
        modelsUsed: [],
        imageEmbedding: undefined, // Initialize embedding fields
        textEmbedding: undefined,
      }
    };

    try {
      processingSteps.push('🔍 Starting product recognition');

      // Step 1: Generate embeddings
      await this.generateEmbeddings(request, result, processingSteps);

      // Step 2: Search vector database for similar products
      const vectorMatches = await this.searchVectorDatabase(request, result, processingSteps);

      // Step 3: Rerank candidates if we have matches
      if (vectorMatches.length > 0) {
        await this.rerankCandidates(request, vectorMatches, result, processingSteps);
      }

      // Step 4: Determine system action based on confidence
      this.determineSystemAction(result, processingSteps);

      // Step 5: Fallback to external search if needed
      if (result.systemAction === 'fallback_to_external') {
        await this.executeExternalFallback(request, result, processingSteps);
      }

      // Step 6: Log interaction for training
      await this.logInteraction(request, result, processingSteps);

      // Step 7: Format user messaging
      this.formatUserResponse(result);

      result.metadata.processingTimeMs = Date.now() - startTime;
      processingSteps.push(`✅ Completed in ${result.metadata.processingTimeMs}ms`);

      return result;

    } catch (error) {
      this.logger.error('Product recognition failed:', error);
      result.metadata.processingTimeMs = Date.now() - startTime;
      processingSteps.push(`❌ Failed: ${error.message}`);
      
      // Return error fallback
      return this.createErrorFallback(request, result, error);
    }
  }

  /**
   * Generate multi-modal embeddings
   */
  private async generateEmbeddings(
    request: ProductRecognitionRequest,
    result: RecognitionResult,
    steps: string[]
  ): Promise<void> {
    const template = this.businessTemplates.get(request.businessTemplate || 'electronics');
    
    try {
      // Generate image embedding if image provided
      if (request.imageUrl || request.imageBase64) {
        steps.push('🖼️  Generating image embedding with SigLIP-2');
        
        result.metadata.modelsUsed.push('SigLIP-2');
        result.metadata.imageEmbedding = await this.embeddingService.generateImageEmbedding({
          imageUrl: request.imageUrl,
          imageBase64: request.imageBase64,
          instruction: template?.embeddingInstructions.image
        }, request.userId);

        steps.push(`✅ Generated ${result.metadata.imageEmbedding.length}D image embedding`);
      }

      // Generate text embedding if query provided
      if (request.textQuery) {
        steps.push('📝 Generating text embedding with Qwen3');
        
        // Extract product details from text query
        const textInput = {
          title: request.textQuery,
          businessTemplate: request.businessTemplate
        };

        result.metadata.modelsUsed.push('Qwen3');
        result.metadata.textEmbedding = await this.embeddingService.generateTextEmbedding(
          textInput,
          request.userId
        );

        steps.push(`✅ Generated ${result.metadata.textEmbedding.length}D text embedding`);
      }

      if (!result.metadata.imageEmbedding && !result.metadata.textEmbedding) {
        throw new Error('At least one input (image or text) must be provided');
      }

    } catch (error) {
      steps.push(`❌ Embedding generation failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Search vector database for similar products
   */
  private async searchVectorDatabase(
    request: ProductRecognitionRequest,
    result: RecognitionResult,
    steps: string[]
  ): Promise<ProductMatch[]> {
    try {
      steps.push('🎯 Searching vector database');

      const searchParams = {
        imageEmbedding: result.metadata.imageEmbedding,
        textEmbedding: result.metadata.textEmbedding,
        businessTemplate: request.businessTemplate,
        limit: 20,
        threshold: 0.7
      };

      const matches = await this.embeddingService.searchSimilarProducts(searchParams);
      
      // We map the raw matches to the final ProductCandidate structure here
      result.rankedCandidates = matches.map(m => ({
        id: m.productVariantId,
        title: m.title,
        description: m.description,
        imageUrl: m.imageUrl,
        price: m.price,
        source: 'internal',
        similarity: m.combinedScore,
        visualSimilarity: m.imageSimilarity,
        textSimilarity: m.textSimilarity,
        url: m.productUrl, // Ensure your embedding service provides this
        metadata: { // Keep raw scores in metadata if needed
          productId: m.productId,
          imageSimilarity: m.imageSimilarity,
          textSimilarity: m.textSimilarity,
          combinedScore: m.combinedScore
        }
      }));

      steps.push(`🔍 Found ${matches.length} potential matches`);
      
      if (matches.length > 0) {
        const topScore = Math.max(...matches.map(m => m.combinedScore));
        steps.push(`🏆 Top similarity score: ${(topScore * 100).toFixed(1)}%`);
      }

      return matches;

    } catch (error) {
      steps.push(`❌ Vector search failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Rerank candidates using Qwen3-Reranker
   */
  private async rerankCandidates(
    request: ProductRecognitionRequest,
    matches: ProductMatch[],
    result: RecognitionResult,
    steps: string[]
  ): Promise<void> {
    try {
      steps.push('🎯 Reranking candidates with Qwen3-Reranker');

      // Convert matches to reranker candidates
      const candidates: RerankerCandidate[] = matches.map((match, index) => ({
        id: match.productVariantId,
        title: match.title,
        description: match.description,
        businessTemplate: match.businessTemplate,
        imageUrl: match.imageUrl,
        metadata: {
          productId: match.productId,
          imageSimilarity: match.imageSimilarity,
          textSimilarity: match.textSimilarity,
          combinedScore: match.combinedScore,
          url: match.productUrl // Pass URL through metadata
        }
      }));

      const rerankerRequest = {
        query: request.textQuery || `Product from image: ${request.businessTemplate || 'general'}`,
        candidates,
        userId: request.userId,
        businessTemplate: request.businessTemplate
      };

      const rerankerResponse = await this.rerankerService.rerankCandidates(rerankerRequest);
      
      // Map the reranker's response back to our final ProductCandidate structure
      result.rankedCandidates = rerankerResponse.rankedCandidates.map(c => ({
        id: c.id,
        title: c.title,
        description: c.description,
        imageUrl: c.imageUrl,
        price: c.price,
        source: 'internal', // These are from our DB
        similarity: c.score, // The reranked score is the final similarity
        visualSimilarity: c.metadata?.imageSimilarity,
        textSimilarity: c.metadata?.textSimilarity,
        url: c.metadata?.url,
        metadata: c.metadata
      }));

      result.confidence = rerankerResponse.confidenceTier;
      result.systemAction = rerankerResponse.systemAction;

      steps.push(`📊 Reranked to ${rerankerResponse.confidenceTier} confidence (${(rerankerResponse.topScore * 100).toFixed(1)}%)`);
      steps.push(`🎬 System action: ${rerankerResponse.systemAction}`);

    } catch (error) {
      steps.push(`❌ Reranking failed: ${error.message}`);
      // Continue with original matches
      result.confidence = 'low';
      result.systemAction = 'fallback_to_external';
    }
  }

  /**
   * Determine final system action
   */
  private determineSystemAction(result: RecognitionResult, steps: string[]): void {
    const template = this.businessTemplates.get('electronics'); // Default template
    
    if (result.rankedCandidates && result.rankedCandidates.length > 0) {
      const topScore = result.rankedCandidates[0].similarity;
      
      if (topScore >= (template?.confidenceThresholds.high || 0.95)) {
        result.confidence = 'high';
        result.systemAction = 'show_single_match';
      } else if (topScore >= (template?.confidenceThresholds.medium || 0.60)) {
        result.confidence = 'medium';
        result.systemAction = 'show_multiple_candidates';
      } else {
        result.confidence = 'low';
        result.systemAction = 'fallback_to_external';
      }
    } else {
      result.confidence = 'low';
      result.systemAction = 'fallback_to_external';
    }

    steps.push(`🎯 Final confidence: ${result.confidence}, action: ${result.systemAction}`);
  }

  /**
   * Execute external fallback search
   */
  private async executeExternalFallback(
    request: ProductRecognitionRequest,
    result: RecognitionResult,
    steps: string[]
  ): Promise<void> {
    try {
      steps.push('🌐 Executing external deep search');
      const template = this.businessTemplates.get(request.businessTemplate || 'electronics') || 
                      this.businessTemplates.get('electronics')!; // Fallback to electronics template
      const searchQuery = request.textQuery || ` unidentified ${template.name}`;
      
      const externalCandidates = await this.firecrawlService.deepProductSearch(
        searchQuery,
        { websites: template.fallbackSources, businessTemplate: request.businessTemplate }
      );

      if (externalCandidates.length === 0) {
        steps.push('🟡 No external candidates found.');
        result.systemAction = 'fallback_to_manual'; // A new final state
        return;
      }
      steps.push(`✅ Found ${externalCandidates.length} potential products from web search.`);

      // The "Agentic" part: Verify candidates with image-to-image similarity
      const verifiedCandidates: Array<any & { visualSimilarity: number }> = [];
      if (result.metadata.imageEmbedding) {
        steps.push('🤖 Agent: Verifying web results against original image...');
        for (const candidate of externalCandidates) {
          if (candidate.imageUrl) {
            try {
              // Get embedding for the image found on the web
              const candidateEmbedding = await this.embeddingService.generateImageEmbedding({ imageUrl: candidate.imageUrl });
              // Compare it to the user's original image embedding
              const similarity = this.embeddingService.calculateEmbeddingSimilarity(result.metadata.imageEmbedding, candidateEmbedding);
              
              steps.push(`- Comparing with ${candidate.title || candidate.url}: Visual Similarity = ${similarity.toFixed(3)}`);
              
              if (similarity > 0.75) { // High confidence visual match
                verifiedCandidates.push({ ...candidate, visualSimilarity: similarity });
              }
            } catch (e) {
              steps.push(`- ⚠️ Could not process image for candidate: ${candidate.title || candidate.url}`);
            }
          }
        }
        steps.push(`✅ Found ${verifiedCandidates.length} visually similar products.`);
      }

      result.rankedCandidates = (verifiedCandidates.length > 0 ? verifiedCandidates : externalCandidates)
        .map(c => ({
          id: c.id, // Assuming the candidate has an ID
          title: c.title,
          description: c.description,
          imageUrl: c.imageUrl,
          price: c.price,
          source: 'web',
          similarity: c.visualSimilarity ?? c.textSimilarity ?? 0, // Prioritize visual similarity
          visualSimilarity: c.visualSimilarity,
          textSimilarity: c.textSimilarity,
          url: c.url,
          metadata: c.metadata,
        }));
      
      if (verifiedCandidates.length > 0) {
        // Sort by visual similarity
        verifiedCandidates.sort((a, b) => b.visualSimilarity - a.visualSimilarity);
        result.rankedCandidates = verifiedCandidates.slice(0, 5); // Take top 5
        
        // If the top match is very strong, we can be confident
        if (verifiedCandidates[0].visualSimilarity > 0.90) {
          result.confidence = 'medium'; // Not 'high' as it's from the web, but good
          result.systemAction = 'show_single_match';
        } else {
          result.confidence = 'low';
          result.systemAction = 'show_multiple_candidates'; // Let the user choose
        }
      } else {
        // If no visual matches, just show the top text-based results
        result.rankedCandidates = externalCandidates.slice(0, 5);
        result.systemAction = 'show_multiple_candidates';
      }

    } catch (error) {
      steps.push(`❌ External search failed: ${error.message}`);
      this.logger.error(`External fallback search failed: ${error.message}`, error.stack);
    }
  }

  /**
   * Log interaction for training flywheel
   */
  private async logInteraction(
    request: ProductRecognitionRequest,
    result: RecognitionResult,
    steps: string[]
  ): Promise<void> {
    try {
      if (!result.rankedCandidates || result.rankedCandidates.length === 0) {
        return;
      }

      const interaction = {
        matchId: '', // Will be set by the logging function
        userId: request.userId,
        imageUrl: request.imageUrl || '',
        query: request.textQuery || 'Image-based search',
        candidates: result.rankedCandidates, // This now matches RerankerCandidate more closely
        rerankerResponse: {
          rankedCandidates: result.rankedCandidates.map(c => ({ 
            ...c, 
            rank: 0, // Add rank to satisfy type
            score: c.similarity // Map similarity to score for the logger
          })), 
          confidenceTier: result.confidence,
          topScore: result.rankedCandidates[0]?.similarity || 0,
          systemAction: result.systemAction,
          processingTimeMs: result.metadata.processingTimeMs,
          metadata: {
            model: 'Qwen3-Reranker-0.5B',
            totalCandidates: result.rankedCandidates.length,
            queryLength: (request.textQuery || '').length
          }
        }
      };

      result.metadata.matchId = await this.rerankerService.logMatchInteraction(interaction);
      steps.push(`📝 Logged interaction for training (ID: ${result.metadata.matchId.substring(0, 8)}...)`);

    } catch (error) {
      steps.push(`❌ Failed to log interaction: ${error.message}`);
    }
  }

  /**
   * Format user response messaging
   */
  private formatUserResponse(result: RecognitionResult): void {
    switch (result.systemAction) {
      case 'show_single_match':
        result.userMessage = "Perfect match found! 🎯";
        result.userInstructions = "Is this your product? Tap 'Yes' to use this data or 'No' to see more options.";
        break;
        
      case 'show_multiple_candidates':
        if (result.rankedCandidates && result.rankedCandidates.length > 0) {
           result.userMessage = "We found a few potential matches. Please select the correct one.";
           result.userInstructions = "Tap the item that matches your product, or 'None of these' to enter details manually.";
        } else {
           // Fallback if candidates are unexpectedly empty
           result.userMessage = "We couldn't find a confident match.";
           result.userInstructions = "Please try searching with more details or add the product manually.";
        }
        break;
        
      case 'fallback_to_manual':
         result.userMessage = "We couldn't find your product online.";
         result.userInstructions = "Please add the product details manually.";
         break;
        
      case 'fallback_to_external':
        result.userMessage = "Searching the web for better matches... 🌐";
        result.userInstructions = "We'll find the best product data from across the internet.";
        break;
    }
  }

  /**
   * Create error fallback response
   */
  private createErrorFallback(
    request: ProductRecognitionRequest,
    result: RecognitionResult,
    error: any
  ): RecognitionResult {
    return {
      ...result,
      confidence: 'low',
      systemAction: 'fallback_to_external',
      userMessage: "Let's search the web for your product 🔍",
      userInstructions: "Don't worry, we'll find great product data for you!",
      processingSteps: [
        ...result.processingSteps,
        `❌ Recognition failed: ${error.message}`,
        '🌐 Falling back to external search'
      ],
      metadata: {
        ...result.metadata,
        processingTimeMs: result.metadata.processingTimeMs,
        modelsUsed: result.metadata.modelsUsed,
      }
    };
  }

  /**
   * Record user feedback on recognition results
   */
  async recordUserFeedback(
    matchId: string,
    userSelection?: number,
    userRejected: boolean = false,
    userFeedback?: string
  ): Promise<void> {
    return this.rerankerService.recordUserFeedback(
      matchId,
      userSelection,
      userRejected,
      userFeedback
    );
  }

  /**
   * Get performance metrics for monitoring
   */
  async getPerformanceMetrics(templateName?: string, days: number = 7): Promise<any> {
    return this.rerankerService.getPerformanceMetrics(templateName, days);
  }

  /**
   * Get business template configuration
   */
  getBusinessTemplate(templateName: string): BusinessTemplateConfig | undefined {
    return this.businessTemplates.get(templateName);
  }

  /**
   * List available business templates
   */
  getAvailableTemplates(): string[] {
    return Array.from(this.businessTemplates.keys());
  }
} 