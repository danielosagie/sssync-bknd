import { Injectable, Logger, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { ProductRecognitionService } from './product-recognition.service';
import { FirecrawlService } from './firecrawl.service';
import { AiGenerationService } from './ai-generation/ai-generation.service';
import { EmbeddingService } from '../embedding/embedding.service';
import { RerankerService } from '../embedding/reranker.service';
import { SupabaseService } from '../common/supabase.service';
import { AiUsageTrackerService } from '../common/ai-usage-tracker.service';
import { ActivityLogService } from '../common/activity-log.service';

// Flexible Input/Output Types
export interface RecognizeStageInput {
  images?: Array<{
    url?: string;
    base64?: string;
    metadata?: any;
  }>;
  links?: string[]; // Direct link submission for quick scan
  textQuery?: string;
  targetSites?: string[]; // Target sites to prioritize (e.g., ["amazon.com", "ebay.com"])
  mode: 'single' | 'bulk' | 'quick_scan';
  skipFullAnalysis?: boolean;
}

export interface RecognizeStageOutput {
  sessionId: string;
  results: Array<{
    sourceIndex: number; // Index of image or link
    sourceType: 'image' | 'link';
    vectorSearchResults: any[];
    externalSearchResults?: any[];
    confidence: 'high' | 'medium' | 'low';
    processingTimeMs: number;
    embeddings?: {
      imageEmbedding?: number[];
      textEmbedding?: number[];
    };
  }>;
  totalProcessingTimeMs: number;
  recommendedNextStage: 'match' | 'generate' | 'manual';
}

export interface MatchStageInput {
  sessionId: string;
  sourceIndexes?: number[]; // Which sources to process (default: all)
  useAiRanking?: boolean;
  userSelections?: Array<{
    sourceIndex: number;
    selectedCandidateIndex?: number;
    rejected?: boolean;
  }>;
}

export interface MatchStageOutput {
  sessionId: string;
  matches: Array<{
    sourceIndex: number;
    rankedCandidates: any[];
    confidence: 'high' | 'medium' | 'low';
    aiSuggestion?: {
      recommendedIndex: number;
      confidence: number;
      reasoning: string;
    };
  }>;
  overallConfidence: 'high' | 'medium' | 'low';
  recommendedAction: 'proceed_to_generate' | 'manual_review' | 'external_search';
}

export interface GenerateStageInput {
  sessionId: string; 
  platformRequests: Array<{
    platform: string;
    requirements: {
      useDescription?: 'scraped_content' | 'ai_generated' | 'user_provided';
      customPrompt?: string;
      restrictions?: string[];
    };
  }>; 
  scrapingTargets?: Array<{
    sourceIndex: number;
    urls: string[];
    customPrompt?: string;
  }>;
}

export interface GenerateStageOutput {
  sessionId: string;
  generatedData: Array<{
    sourceIndex: number;
    platforms: Record<string, {
      title: string;
      description: string;
      price?: number;
      specifications?: any;
      images?: string[];
      source: 'ai_generated' | 'scraped_content' | 'hybrid';
    }>;
    scrapedData?: {
      content: any[];
      processedData: any;
    };
  }>;
  storageResults: {
    productsCreated: number;
    variantsCreated: number;
    aiContentStored: number;
    embeddingsStored: number;
  };
}

// Session Management
interface OrchestratorSession {
  id: string;
  userId: string;
  createdAt: Date;
  currentStage: 'recognize' | 'match' | 'generate' | 'completed';
  recognizeData?: RecognizeStageOutput;
  matchData?: MatchStageOutput;
  generateData?: GenerateStageOutput;
  metadata: {
    mode: 'single' | 'bulk' | 'quick_scan';
    totalSources: number;
    targetSites?: string[];
  };
}

@Injectable()
export class ProductOrchestratorService {
  private readonly logger = new Logger(ProductOrchestratorService.name);
  private readonly sessions = new Map<string, OrchestratorSession>();

  constructor(
    private readonly productRecognitionService: ProductRecognitionService,
    private readonly firecrawlService: FirecrawlService,
    private readonly aiGenerationService: AiGenerationService,
    private readonly embeddingService: EmbeddingService,
    private readonly rerankerService: RerankerService,
    private readonly supabaseService: SupabaseService,
    private readonly aiUsageTracker: AiUsageTrackerService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  /**
   * STAGE 1: RECOGNIZE
   * Flexible recognition supporting images, links, or text queries
   */
  async recognize(userId: string, input: RecognizeStageInput): Promise<RecognizeStageOutput> {
    const startTime = Date.now();
    const sessionId = `orch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Validate input - must have at least one source
    const totalSources = (input.images?.length || 0) + (input.links?.length || 0);
    if (totalSources === 0 && !input.textQuery) {
      throw new BadRequestException('Must provide images, links, or text query');
    }

    this.logger.log(`[Stage 1: Recognize] User: ${userId}, Session: ${sessionId}, Mode: ${input.mode}, Sources: ${totalSources}`);

    try {
      const results: RecognizeStageOutput['results'] = [];
      let sourceIndex = 0;

      // Process images if provided
      if (input.images && input.images.length > 0) {
        for (const image of input.images) {
          const result = await this.processImageSource(userId, image, sourceIndex, input, sessionId);
          results.push(result);
          sourceIndex++;
        }
      }

      // Process links if provided
      if (input.links && input.links.length > 0) {
        for (const link of input.links) {
          const result = await this.processLinkSource(userId, link, sourceIndex, input, sessionId);
          results.push(result);
          sourceIndex++;
        }
      }

      // Process text-only query if no images or links
      if (!input.images?.length && !input.links?.length && input.textQuery) {
        const result = await this.processTextOnlySource(userId, input.textQuery, sourceIndex, input, sessionId);
        results.push(result);
      }

      // Determine overall confidence and next recommended stage
      const highConfidenceCount = results.filter(r => r.confidence === 'high').length;
      const mediumConfidenceCount = results.filter(r => r.confidence === 'medium').length;
      
      let recommendedNextStage: 'match' | 'generate' | 'manual';
      if (highConfidenceCount === results.length && results.length > 0) {
        recommendedNextStage = 'generate'; // Skip matching if all high confidence
      } else if (highConfidenceCount + mediumConfidenceCount >= results.length * 0.7) {
        recommendedNextStage = 'match'; // Go to matching for review
      } else {
        recommendedNextStage = 'manual'; // Too low confidence, needs manual intervention
      }

      const output: RecognizeStageOutput = {
        sessionId,
        results,
        totalProcessingTimeMs: Date.now() - startTime,
        recommendedNextStage
      };

      // Store session
      const session: OrchestratorSession = {
        id: sessionId,
        userId,
        createdAt: new Date(),
        currentStage: 'recognize',
        recognizeData: output,
        metadata: {
          mode: input.mode,
          totalSources,
          targetSites: input.targetSites
        }
      };
      this.sessions.set(sessionId, session);

      this.logger.log(`[Stage 1: Recognize] Completed for session ${sessionId}, recommended next: ${recommendedNextStage}`);
      return output;

    } catch (error) {
      this.logger.error(`[Stage 1: Recognize] Error for session ${sessionId}: ${error.message}`, error.stack);
      throw new InternalServerErrorException(`Recognition stage failed: ${error.message}`);
    }
  }

  /**
   * STAGE 2: MATCH
   * Enhanced matching with AI ranking
   */
  async match(userId: string, input: MatchStageInput): Promise<MatchStageOutput> {
    this.logger.log(`[Stage 2: Match] User: ${userId}, Session: ${input.sessionId}`);

    const session = this.sessions.get(input.sessionId);
    if (!session || session.userId !== userId) {
      throw new BadRequestException('Invalid session or access denied');
    }

    if (!session.recognizeData) {
      throw new BadRequestException('Recognition stage must be completed first');
    }

    try {
      const matches: MatchStageOutput['matches'] = [];
      const recognizeResults = session.recognizeData.results;

      // Process specified sources or all if none specified
      const sourcesToProcess = input.sourceIndexes || recognizeResults.map((_, index) => index);

      for (const sourceIndex of sourcesToProcess) {
        const recognizeResult = recognizeResults[sourceIndex];
        if (!recognizeResult) continue;

        // Check for user selection
        const userSelection = input.userSelections?.find(s => s.sourceIndex === sourceIndex);
        if (userSelection?.rejected) {
          matches.push({
            sourceIndex,
            rankedCandidates: [],
            confidence: 'low'
          });
          continue;
        }

        if (userSelection?.selectedCandidateIndex !== undefined) {
          const selectedCandidate = recognizeResult.vectorSearchResults[userSelection.selectedCandidateIndex];
          matches.push({
            sourceIndex,
            rankedCandidates: selectedCandidate ? [selectedCandidate] : [],
            confidence: recognizeResult.confidence
          });
          continue;
        }

        // Enhance with AI reranking if requested
        let rankedCandidates = recognizeResult.vectorSearchResults;
        let aiSuggestion;

        if (input.useAiRanking && rankedCandidates.length > 1) {
          try {
            const rerankerResponse = await this.rerankerService.rerankCandidates({
              query: this.buildQueryFromSource(recognizeResult, session.metadata.targetSites),
              candidates: rankedCandidates.map(match => ({
                id: match.variantId || match.id,
                title: match.title,
                description: match.description || match.snippet,
                metadata: match
              })),
              userId
            });

            rankedCandidates = rerankerResponse.rankedCandidates.map(c => c.metadata);
            
            if (rerankerResponse.rankedCandidates.length > 0) {
              aiSuggestion = {
                recommendedIndex: 0,
                confidence: rerankerResponse.rankedCandidates[0].score || 0,
                reasoning: `AI reranker suggests this match based on content similarity and target sites: ${session.metadata.targetSites?.join(', ') || 'general'}`
              };
            }
          } catch (error) {
            this.logger.warn(`[Stage 2: Match] Reranker failed for source ${sourceIndex}: ${error.message}`);
          }
        }

        matches.push({
          sourceIndex,
          rankedCandidates,
          confidence: recognizeResult.confidence,
          aiSuggestion
        });
      }

      // Determine overall confidence and recommended action
      const highConfidenceMatches = matches.filter(m => m.confidence === 'high').length;
      const totalMatches = matches.length;
      
      let overallConfidence: 'high' | 'medium' | 'low';
      let recommendedAction: 'proceed_to_generate' | 'manual_review' | 'external_search';

      if (highConfidenceMatches === totalMatches && totalMatches > 0) {
        overallConfidence = 'high';
        recommendedAction = 'proceed_to_generate';
      } else if (highConfidenceMatches >= totalMatches * 0.7) {
        overallConfidence = 'medium';
        recommendedAction = 'manual_review';
      } else {
        overallConfidence = 'low';
        recommendedAction = 'external_search';
      }

      const output: MatchStageOutput = {
        sessionId: input.sessionId,
        matches,
        overallConfidence,
        recommendedAction
      };

      // Update session
      session.currentStage = 'match';
      session.matchData = output;

      this.logger.log(`[Stage 2: Match] Completed for session ${input.sessionId}, overall confidence: ${overallConfidence}`);
      return output;

    } catch (error) {
      this.logger.error(`[Stage 2: Match] Error for session ${input.sessionId}: ${error.message}`, error.stack);
      throw new InternalServerErrorException(`Matching stage failed: ${error.message}`);
    }
  }

  /**
   * STAGE 3: GENERATE
   * Flexible generation with web scraping and AI
   */
  async generate(userId: string, input: GenerateStageInput): Promise<GenerateStageOutput> {
    this.logger.log(`[Stage 3: Generate] User: ${userId}, Session: ${input.sessionId}`);

    const session = this.sessions.get(input.sessionId);
    if (!session || session.userId !== userId) {
      throw new BadRequestException('Invalid session or access denied');
    }

    if (!session.matchData) {
      throw new BadRequestException('Matching stage must be completed first');
    }

    try {
      const generatedData: GenerateStageOutput['generatedData'] = [];
      let productsCreated = 0;
      let variantsCreated = 0;
      let aiContentStored = 0;
      let embeddingsStored = 0;

      // Process each matched source
      for (const match of session.matchData.matches) {
        const sourceIndex = match.sourceIndex;
        const sourceData: GenerateStageOutput['generatedData'][0] = {
          sourceIndex,
          platforms: {}
        };

        // Handle web scraping if specified
        const scrapingTarget = input.scrapingTargets?.find(t => t.sourceIndex === sourceIndex);
        if (scrapingTarget && scrapingTarget.urls.length > 0) {
          try {
            sourceData.scrapedData = await this.processWebScraping(
              userId, 
              scrapingTarget, 
              match.rankedCandidates[0],
              session.metadata.targetSites
            );
          } catch (error) {
            this.logger.warn(`[Stage 3: Generate] Web scraping failed for source ${sourceIndex}: ${error.message}`);
          }
        }

        // Generate platform-specific data
        for (const platformRequest of input.platformRequests) {
          try {
            const platformData = await this.generatePlatformData(
              userId,
              platformRequest,
              match.rankedCandidates[0],
              sourceData.scrapedData?.processedData
            );
            
            sourceData.platforms[platformRequest.platform] = platformData;
          } catch (error) {
            this.logger.warn(`[Stage 3: Generate] Platform generation failed for ${platformRequest.platform}: ${error.message}`);
          }
        }

        // Store the generated data and embeddings
        const storageResult = await this.storeGeneratedData(userId, sourceData, session.metadata.targetSites);
        productsCreated += storageResult.productsCreated;
        variantsCreated += storageResult.variantsCreated;
        aiContentStored += storageResult.aiContentStored;
        embeddingsStored += storageResult.embeddingsStored;

        generatedData.push(sourceData);
      }

      const output: GenerateStageOutput = {
        sessionId: input.sessionId,
        generatedData,
        storageResults: {
          productsCreated,
          variantsCreated,
          aiContentStored,
          embeddingsStored
        }
      };

      // Update session
      session.currentStage = 'generate';
      session.generateData = output;

      this.logger.log(`[Stage 3: Generate] Completed for session ${input.sessionId}, created ${productsCreated} products, stored ${embeddingsStored} embeddings`);
      return output;

    } catch (error) {
      this.logger.error(`[Stage 3: Generate] Error for session ${input.sessionId}: ${error.message}`, error.stack);
      throw new InternalServerErrorException(`Generation stage failed: ${error.message}`);
    }
  }

  /**
   * Get session status and data
   */
  async getSession(userId: string, sessionId: string): Promise<OrchestratorSession | null> {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId) {
      return null;
    }
    return session;
  }

  /**
   * Clean up old sessions
   */
  cleanupOldSessions(maxAgeHours: number = 24): void {
    const cutoffTime = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
    
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.createdAt < cutoffTime) {
        this.sessions.delete(sessionId);
      }
    }
  }

  // Private helper methods
  private async processImageSource(
    userId: string, 
    image: { url?: string; base64?: string; metadata?: any }, 
    index: number,
    input: RecognizeStageInput,
    sessionId: string
  ): Promise<RecognizeStageOutput['results'][0]> {
    const startTime = Date.now();
    
    try {
      // Generate and store image embedding
      let imageEmbedding: number[] | undefined;
      if (image.url || image.base64) {
        imageEmbedding = await this.embeddingService.generateImageEmbedding({
          imageUrl: image.url,
          imageBase64: image.base64,
          instruction: `Encode this product image for similarity search${input.targetSites ? ` prioritizing ${input.targetSites.join(', ')}` : ''}`
        }, userId);
      }

      // Generate text embedding if query provided
      let textEmbedding: number[] | undefined;
      if (input.textQuery) {
        textEmbedding = await this.embeddingService.generateTextEmbedding({
          title: input.textQuery,
          description: `Product search targeting: ${input.targetSites?.join(', ') || 'any sites'}`
        }, userId);
      }

      // Search vector database
      const vectorSearchResults = await this.embeddingService.searchSimilarProducts({
        imageEmbedding,
        textEmbedding,
        threshold: 0.6, // More lenient threshold for flexibility
        limit: 15
      });

      // Optional: External search if low confidence and not skipping analysis
      let externalSearchResults;
      if (!input.skipFullAnalysis && vectorSearchResults.length === 0) {
        try {
          // Use flexible search targeting specified sites
          const searchQuery = this.buildSearchQuery(input.textQuery || 'product', input.targetSites);
          externalSearchResults = await this.firecrawlService.search(searchQuery);
        } catch (error) {
          this.logger.warn(`External search failed for image ${index}: ${error.message}`);
        }
      }

      const confidence = this.determineConfidence(vectorSearchResults, externalSearchResults);

      return {
        sourceIndex: index,
        sourceType: 'image',
        vectorSearchResults,
        externalSearchResults,
        confidence,
        processingTimeMs: Date.now() - startTime,
        embeddings: {
          imageEmbedding,
          textEmbedding
        }
      };

    } catch (error) {
      this.logger.error(`[processImageSource] Error for image ${index}: ${error.message}`);
      return {
        sourceIndex: index,
        sourceType: 'image',
        vectorSearchResults: [],
        confidence: 'low',
        processingTimeMs: Date.now() - startTime
      };
    }
  }

  private async processLinkSource(
    userId: string,
    link: string,
    index: number,
    input: RecognizeStageInput,
    sessionId: string
  ): Promise<RecognizeStageOutput['results'][0]> {
    const startTime = Date.now();
    
    try {
      // Scrape the link first
      let scrapedContent;
      try {
        scrapedContent = await this.firecrawlService.scrape(link);
                 await this.aiUsageTracker.trackFirecrawlUsage(userId, 'scrape_url', 1, { url: link });
      } catch (error) {
        this.logger.warn(`Failed to scrape link ${link}: ${error.message}`);
      }

      // Build text for embedding from scraped content or fallback to link + query
      const textForEmbedding = scrapedContent?.content || 
        `${input.textQuery || 'Product'} from ${link}`;

      // Generate text embedding
      const textEmbedding = await this.embeddingService.generateTextEmbedding({
        title: textForEmbedding,
        description: `Content from ${link}${input.targetSites ? ` related to ${input.targetSites.join(', ')}` : ''}`
      }, userId);

      // Search vector database
      const vectorSearchResults = await this.embeddingService.searchSimilarProducts({
        textEmbedding,
        threshold: 0.6,
        limit: 15
      });

      const confidence = this.determineConfidence(vectorSearchResults, []);

      return {
        sourceIndex: index,
        sourceType: 'link',
        vectorSearchResults,
        confidence,
        processingTimeMs: Date.now() - startTime,
        embeddings: {
          textEmbedding
        }
      };

    } catch (error) {
      this.logger.error(`[processLinkSource] Error for link ${link}: ${error.message}`);
      return {
        sourceIndex: index,
        sourceType: 'link',
        vectorSearchResults: [],
        confidence: 'low',
        processingTimeMs: Date.now() - startTime
      };
    }
  }

  private async processTextOnlySource(
    userId: string,
    textQuery: string,
    index: number,
    input: RecognizeStageInput,
    sessionId: string
  ): Promise<RecognizeStageOutput['results'][0]> {
    const startTime = Date.now();
    
    try {
      // Generate text embedding
      const textEmbedding = await this.embeddingService.generateTextEmbedding({
        title: textQuery,
        description: `Search query targeting: ${input.targetSites?.join(', ') || 'any sites'}`
      }, userId);

      // Search vector database
      const vectorSearchResults = await this.embeddingService.searchSimilarProducts({
        textEmbedding,
        threshold: 0.6,
        limit: 15
      });

      // External search if needed
      let externalSearchResults;
      if (!input.skipFullAnalysis && vectorSearchResults.length < 3) {
        try {
          const searchQuery = this.buildSearchQuery(textQuery, input.targetSites);
          externalSearchResults = await this.firecrawlService.search(searchQuery);
        } catch (error) {
          this.logger.warn(`External search failed for text query: ${error.message}`);
        }
      }

      const confidence = this.determineConfidence(vectorSearchResults, externalSearchResults);

      return {
        sourceIndex: index,
        sourceType: 'link', // Text-only is treated as link type
        vectorSearchResults,
        externalSearchResults,
        confidence,
        processingTimeMs: Date.now() - startTime,
        embeddings: {
          textEmbedding
        }
      };

    } catch (error) {
      this.logger.error(`[processTextOnlySource] Error for text query: ${error.message}`);
      return {
        sourceIndex: index,
        sourceType: 'link',
        vectorSearchResults: [],
        confidence: 'low',
        processingTimeMs: Date.now() - startTime
      };
    }
  }

  private async processWebScraping(
    userId: string,
    scrapingTarget: { sourceIndex: number; urls: string[]; customPrompt?: string; },
    selectedMatch: any,
    targetSites?: string[]
  ): Promise<{ content: any[]; processedData: any }> {
    const content: Array<{ url: string; content?: any; error?: string; }> = [];
    
    for (const url of scrapingTarget.urls) {
      try {
        const scraped = await this.firecrawlService.scrape(url);
        content.push({ url, content: scraped });
        
        await this.aiUsageTracker.trackFirecrawlUsage(userId, 'scrape_url', 1, { 
          url, 
          targetSites: targetSites?.join(',') 
        });
      } catch (error) {
        this.logger.warn(`Firecrawl scraping failed for ${url}: ${error.message}`);
        content.push({ url, error: error.message });
      }
    }

    // Process scraped content with AI
    let processedData: any = null;
    const successfulScrapes = content.filter((s: { error?: any }) => !s.error);
    if (successfulScrapes.length > 0) {
      try {
        processedData = await this.aiGenerationService.generateProductDetailsFromScrapedData(
          successfulScrapes.map(s => s.content),
          scrapingTarget.customPrompt || `Extract product data: ${selectedMatch?.title || 'Unknown Product'} from ${targetSites?.join(', ') || 'web sources'}`,
          targetSites?.join(',') || 'general'
        );
      } catch (error) {
        this.logger.warn(`AI processing of scraped data failed: ${error.message}`);
      }
    }

    return { content, processedData };
  }

  private async generatePlatformData(
    userId: string,
    platformRequest: GenerateStageInput['platformRequests'][0],
    selectedMatch: any,
    scrapedData?: any
  ): Promise<GenerateStageOutput['generatedData'][0]['platforms'][string]> {
    // Flexible content sourcing
    let sourceContent = '';
    let source: 'ai_generated' | 'scraped_content' | 'hybrid' = 'ai_generated';

    if (platformRequest.requirements.useDescription === 'scraped_content' && scrapedData) {
      sourceContent = scrapedData.description || JSON.stringify(scrapedData);
      source = 'scraped_content';
    } else if (platformRequest.requirements.useDescription === 'user_provided' && platformRequest.requirements.customPrompt) {
      sourceContent = platformRequest.requirements.customPrompt;
      source = 'hybrid';
    } else {
      sourceContent = selectedMatch?.description || selectedMatch?.title || '';
      source = 'ai_generated';
    }

    // Generate platform-specific content
    const prompt = `
Generate ${platformRequest.platform} product listing data:
Product: ${selectedMatch?.title || 'Product'}
Source Content: ${sourceContent}
Custom Requirements: ${platformRequest.requirements.customPrompt || 'Standard listing'}
Restrictions: ${platformRequest.requirements.restrictions?.join(', ') || 'None'}

Return JSON with: title, description, price, specifications, images
    `;

    try {
      // TODO: Replace with proper AI generation call
      const generated = {
        title: selectedMatch?.title || 'Generated Product',
        description: sourceContent || 'Generated description', 
        price: selectedMatch?.price || 0,
        specifications: {},
        images: []
      };
      
      return {
        title: generated.title || selectedMatch?.title || 'Generated Product',
        description: generated.description || sourceContent,
        price: generated.price || selectedMatch?.price,
        specifications: generated.specifications || {},
        images: generated.images || (selectedMatch?.imageUrl ? [selectedMatch.imageUrl] : []),
        source
      };
    } catch (error) {
      this.logger.warn(`Platform data generation failed: ${error.message}`);
      return {
        title: selectedMatch?.title || 'Unknown Product',
        description: sourceContent || 'No description available',
        source: 'ai_generated'
      };
    }
  }

  private async storeGeneratedData(
    userId: string,
    sourceData: GenerateStageOutput['generatedData'][0],
    targetSites?: string[]
  ): Promise<{ productsCreated: number; variantsCreated: number; aiContentStored: number; embeddingsStored: number }> {
    let productsCreated = 0;
    let variantsCreated = 0;
    let aiContentStored = 0;
    let embeddingsStored = 0;

    try {
      const supabase = this.supabaseService.getClient();
      
      // Create a product for this source's data
      const { data: product, error: productError } = await supabase
        .from('Products')
        .insert({
          UserId: userId,
          IsArchived: false
        })
        .select()
        .single();

      if (productError || !product) {
        throw new Error(`Failed to create product: ${productError?.message}`);
      }
      productsCreated++;

      // Create variant with the first platform's data
      const firstPlatform = Object.keys(sourceData.platforms)[0];
      if (firstPlatform) {
        const platformData = sourceData.platforms[firstPlatform];
        
        const { data: variant, error: variantError } = await supabase
          .from('ProductVariants')
          .insert({
            ProductId: product.Id,
            UserId: userId,
            Title: platformData.title,
            Description: platformData.description,
            Price: platformData.price || 0,
            Sku: `ORCH-${product.Id.substring(0, 8)}`
          })
          .select()
          .single();

        if (!variantError && variant) {
          variantsCreated++;

          // Store embeddings for the variant
          try {
            // Generate and store title embedding
            if (platformData.title) {
              const titleEmbedding = await this.embeddingService.generateTextEmbedding({
                title: platformData.title,
                description: `Generated for platforms: ${Object.keys(sourceData.platforms).join(', ')}`
              }, userId);

              await this.embeddingService.storeProductEmbedding({
                productId: product.Id,
                ProductVariantId: variant.Id,
                textEmbedding: titleEmbedding,
                productText: platformData.title,
                sourceType: 'ai_generated',
                businessTemplate: 'flexible_generation'
              });
              embeddingsStored++;
            }

            // Generate and store description embedding
            if (platformData.description) {
              const descEmbedding = await this.embeddingService.generateTextEmbedding({
                title: platformData.description,
                description: `Generated content from sources: ${targetSites?.join(', ') || 'various'}`
              }, userId);

              await this.embeddingService.storeProductEmbedding({
                productId: product.Id,
                ProductVariantId: variant.Id,
                textEmbedding: descEmbedding,
                productText: platformData.description,
                sourceType: 'ai_generated',
                businessTemplate: 'flexible_generation'
              });
              embeddingsStored++;
            }
          } catch (embeddingError) {
            this.logger.warn(`Failed to store embeddings: ${embeddingError.message}`);
          }
        }

        // Store AI generated content for each platform
        for (const [platform, data] of Object.entries(sourceData.platforms)) {
          const { error: aiError } = await supabase
            .from('AiGeneratedContent')
            .insert({
              ProductId: product.Id,
              ContentType: 'orchestrator_generated',
              SourceApi: 'orchestrator-flexible',
              GeneratedText: JSON.stringify(data),
              Metadata: { 
                platform, 
                source: data.source,
                targetSites: targetSites?.join(','),
                sourceIndex: sourceData.sourceIndex
              },
              IsActive: true
            });

          if (!aiError) {
            aiContentStored++;
          }
        }

        // Store scraped data if available
        if (sourceData.scrapedData) {
          const { error: scrapedError } = await supabase
            .from('AiGeneratedContent')
            .insert({
              ProductId: product.Id,
              ContentType: 'scraped_content',
              SourceApi: 'firecrawl-flexible',
              GeneratedText: JSON.stringify(sourceData.scrapedData),
              Metadata: { 
                sourceIndex: sourceData.sourceIndex,
                targetSites: targetSites?.join(','),
                scrapedUrls: sourceData.scrapedData.content.map(s => s.url)
              },
              IsActive: true
            });

          if (!scrapedError) {
            aiContentStored++;
          }
        }
      }

      return { productsCreated, variantsCreated, aiContentStored, embeddingsStored };

    } catch (error) {
      this.logger.error(`Failed to store generated data: ${error.message}`);
      return { productsCreated, variantsCreated, aiContentStored, embeddingsStored };
    }
  }

  private buildSearchQuery(query: string, targetSites?: string[]): string {
    if (targetSites && targetSites.length > 0) {
      const siteQuery = targetSites.map(site => `site:${site}`).join(' OR ');
      return `${query} (${siteQuery})`;
    }
    return query;
  }

  private buildQueryFromSource(recognizeResult: any, targetSites?: string[]): string {
    const baseQuery = recognizeResult.vectorSearchResults[0]?.title || 'product search';
    return `${baseQuery}${targetSites ? ` from ${targetSites.join(' ')}` : ''}`;
  }

  private determineConfidence(vectorResults: any[], externalResults?: any[]): 'high' | 'medium' | 'low' {
    if (vectorResults.length > 0) {
      const topScore = Math.max(...vectorResults.map(r => r.combinedScore || r.score || 0));
      if (topScore >= 0.85) return 'high';
      if (topScore >= 0.65) return 'medium';
    }
    
    if (externalResults && externalResults.length > 0) {
      return 'medium';
    }
    
    return 'low';
  }
} 