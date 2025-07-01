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

export interface RecognitionResult {
  // Core results
  confidence: 'high' | 'medium' | 'low';
  systemAction: 'show_single_match' | 'show_multiple_candidates' | 'fallback_to_external';
  
  // Product matches
  productMatches?: ProductMatch[];
  rankedCandidates?: any[];
  
  // Embeddings
  imageEmbedding?: number[];
  textEmbedding?: number[];
  
  // External fallback
  webSearchResults?: any[];
  scrapedData?: any;
  
  // Metadata
  processingSteps: string[];
  processingTimeMs: number;
  matchId?: string;
  
  // User interaction
  userMessage: string;
  userInstructions: string;
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
      processingSteps,
      processingTimeMs: 0,
      userMessage: '',
      userInstructions: ''
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

      result.processingTimeMs = Date.now() - startTime;
      processingSteps.push(`✅ Completed in ${result.processingTimeMs}ms`);

      return result;

    } catch (error) {
      this.logger.error('Product recognition failed:', error);
      result.processingTimeMs = Date.now() - startTime;
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
        
        result.imageEmbedding = await this.embeddingService.generateImageEmbedding({
          imageUrl: request.imageUrl,
          imageBase64: request.imageBase64,
          instruction: template?.embeddingInstructions.image
        }, request.userId);

        steps.push(`✅ Generated ${result.imageEmbedding.length}D image embedding`);
      }

      // Generate text embedding if query provided
      if (request.textQuery) {
        steps.push('📝 Generating text embedding with Qwen3');
        
        // Extract product details from text query
        const textInput = {
          title: request.textQuery,
          businessTemplate: request.businessTemplate
        };

        result.textEmbedding = await this.embeddingService.generateTextEmbedding(
          textInput,
          request.userId
        );

        steps.push(`✅ Generated ${result.textEmbedding.length}D text embedding`);
      }

      if (!result.imageEmbedding && !result.textEmbedding) {
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
        imageEmbedding: result.imageEmbedding,
        textEmbedding: result.textEmbedding,
        businessTemplate: request.businessTemplate,
        limit: 20,
        threshold: 0.7
      };

      const matches = await this.embeddingService.searchSimilarProducts(searchParams);
      result.productMatches = matches;

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
        id: match.variantId,
        title: match.title,
        description: match.description,
        businessTemplate: match.businessTemplate,
        imageUrl: match.imageUrl,
        metadata: {
          productId: match.productId,
          imageSimilarity: match.imageSimilarity,
          textSimilarity: match.textSimilarity,
          combinedScore: match.combinedScore
        }
      }));

      const rerankerRequest = {
        query: request.textQuery || `Product from image: ${request.businessTemplate || 'general'}`,
        candidates,
        userId: request.userId,
        businessTemplate: request.businessTemplate
      };

      const rerankerResponse = await this.rerankerService.rerankCandidates(rerankerRequest);
      
      result.rankedCandidates = rerankerResponse.rankedCandidates;
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
      const topScore = result.rankedCandidates[0].score;
      
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
      steps.push('🌐 Executing external fallback search');

      const template = this.businessTemplates.get(request.businessTemplate || 'electronics');
      const searchQuery = request.textQuery || 
        `${request.businessTemplate || 'product'} from image`;

      // Use Firecrawl for deep search with correct method signature
      const searchResults = await this.firecrawlService.deepProductSearch(
        searchQuery,
        {
          websites: template?.fallbackSources || ['amazon.com', 'google.com'],
          businessTemplate: request.businessTemplate
        }
      );

      result.webSearchResults = searchResults;
      result.scrapedData = { results: searchResults };

      steps.push(`🔍 Found ${searchResults.length} external results`);

      // Try to find better matches from external data
      if (searchResults.length > 0) {
        await this.enhanceWithExternalData({ results: searchResults }, result, steps);
      }

    } catch (error) {
      steps.push(`❌ External fallback failed: ${error.message}`);
    }
  }

  /**
   * Enhance results with external search data
   */
  private async enhanceWithExternalData(
    searchResults: any,
    result: RecognitionResult,
    steps: string[]
  ): Promise<void> {
    try {
      // Convert external results to candidates for potential reranking
      const externalCandidates = searchResults.results.slice(0, 5).map((item: any, index: number) => ({
        id: `external_${index}`,
        title: item.title || 'Unknown Product',
        description: item.description || '',
        price: item.price,
        imageUrl: item.image,
        metadata: {
          source: 'external_search',
          url: item.url,
          confidence: item.confidence || 0.5
        }
      }));

      result.rankedCandidates = [...(result.rankedCandidates || []), ...externalCandidates];
      steps.push(`🔗 Enhanced with ${externalCandidates.length} external candidates`);

    } catch (error) {
      steps.push(`❌ External enhancement failed: ${error.message}`);
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
        candidates: result.rankedCandidates.map(c => ({
          id: c.id,
          title: c.title,
          description: c.description,
          businessTemplate: request.businessTemplate
        })),
        rerankerResponse: {
          rankedCandidates: result.rankedCandidates,
          confidenceTier: result.confidence,
          topScore: result.rankedCandidates[0]?.score || 0,
          systemAction: result.systemAction,
          processingTimeMs: result.processingTimeMs,
          metadata: {
            model: 'Qwen3-Reranker-0.5B',
            totalCandidates: result.rankedCandidates.length,
            queryLength: (request.textQuery || '').length
          }
        }
      };

      result.matchId = await this.rerankerService.logMatchInteraction(interaction);
      steps.push(`📝 Logged interaction for training (ID: ${result.matchId.substring(0, 8)}...)`);

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
        result.userMessage = `Found ${result.rankedCandidates?.length || 0} similar products 📋`;
        result.userInstructions = "Select the best match or tap 'None of These' to search externally.";
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
      ]
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