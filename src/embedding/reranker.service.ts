import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../common/supabase.service';
import { AiUsageTrackerService } from '../common/ai-usage-tracker.service';
import { ProductMatch } from './embedding.service';

export interface RerankerCandidate {
  id: string;
  title: string;
  description?: string;
  price?: number;
  brand?: string;
  category?: string;
  imageUrl?: string;
  businessTemplate?: string;
  metadata?: any;
  searchKeywords?: any;
}

export interface RerankerRequest {
  targetUrl?: string;
  query: string; // User query or extracted product description
  candidates: RerankerCandidate[];
  userId?: string;
  businessTemplate?: string;
  maxCandidates?: number;
}

export interface RankedCandidate extends RerankerCandidate {
  rank: number;
  score: number;
  explanation?: string;
}

export interface RerankerResponse {
  rankedCandidates: RankedCandidate[];
  confidenceTier: 'high' | 'medium' | 'low';
  topScore: number;
  systemAction: 'show_single_match' | 'show_multiple_candidates' | 'fallback_to_external' | 'fallback_to_manual';
  processingTimeMs: number;
  metadata: {
    model: string;
    totalCandidates: number;
    queryLength: number;
  };
}

export interface MatchInteraction {
  matchId: string;
  userId: string;
  imageUrl: string;
  query: string;
  candidates: RerankerCandidate[];
  rerankerResponse: RerankerResponse;
  userSelection?: number;
  userRejected?: boolean;
  userFeedback?: string;
}

@Injectable()
export class RerankerService {
  private readonly logger = new Logger(RerankerService.name);
  private readonly aiServerUrl: string;
  private readonly reputableHosts: string[];

  // Confidence thresholds for tier classification (adjusted for hybrid search)
  private readonly HIGH_CONFIDENCE_THRESHOLD = 0.80;  // Lowered from 0.95
  private readonly MEDIUM_CONFIDENCE_THRESHOLD = 0.50; // Lowered from 0.60
  private readonly NO_MATCH_THRESHOLD = 0.35;          // New: below this = no good matches
  
  constructor(
    private readonly configService: ConfigService,
    private readonly supabaseService: SupabaseService,
    private readonly aiUsageTracker: AiUsageTrackerService
  ) {
    this.aiServerUrl = this.configService.get<string>('AI_SERVER_URL') || 'http://localhost:8000';
    const hostsFromEnv = this.configService.get<string>('RERANK_REPUTABLE_HOSTS');
    const defaultHosts = ['amazon.com','ebay.com','bestbuy.com','target.com','walmart.com'];
    this.reputableHosts = (hostsFromEnv ? hostsFromEnv.split(',').map(h => h.trim()).filter(Boolean) : defaultHosts);
  }

  /**
   * Rerank product candidates and determine confidence tier
   */
  async rerankCandidates(request: RerankerRequest): Promise<RerankerResponse> {
    const startTime = Date.now();

    // Create a proper search query from the target URL or use a generic query
    const searchQuery = request.targetUrl 
      ? `Find the EXACT MATCHING product shown in this image: ${request.targetUrl}. Look for the same device/item, NOT similar products. Prioritize: 1) Exact product matches 2) Official retail listings 3) Clear product names in title 4) Reasonable prices. AVOID: forum posts, YouTube videos, Pinterest pins, unrelated products, accessories only.`
      : request.query || 'Find the most relevant and matching product from the candidate list';
    
    this.logger.log(`[RerankerDebug] Using search query: "${searchQuery}"`);
    
    try {
      // Prepare candidates for reranking - fix metadata format issue
      const candidatesForReranker = request.candidates.map(candidate => ({
        id: candidate.id,
        title: candidate.title,
        description: candidate.description || '',
        price: candidate.price || 0,
        brand: candidate.brand || '',
        category: candidate.category || '',
        business_template: candidate.businessTemplate || '',
        searchKeywords: candidate.searchKeywords || ''
        // Remove metadata entirely to avoid validation errors
      }));

      this.logger.log(`[RerankerDebug] Sending ${candidatesForReranker.length} candidates to AI server`);

      // Call the AI server reranker endpoint
      const response = await fetch(`${this.aiServerUrl}/rerank`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: searchQuery,
          candidates: candidatesForReranker,
          top_k: request.maxCandidates || 10
        }),
      });

      if (!response.ok) {
        // Get detailed error information
        const errorText = await response.text();
        this.logger.error(`[RerankerDebug] AI Server Error: ${response.status} ${response.statusText}`);
        this.logger.error(`[RerankerDebug] Error details: ${errorText}`);
        throw new Error(`Reranker API error: ${response.statusText} - ${errorText}`);
      }

      const data = await response.json();
      this.logger.log(`[RerankerDebug] AI Server response received successfully`);
      const processingTime = Date.now() - startTime;

      // Build ranked candidates with original data
      // Re-weight scores to favor reputable sources, clean titles, and presence of price
      // Pull latest dynamic boosts if available (from nightly job)
      let dynamicPriceBoost = 0.05;
      let dynamicHostBoost = 0.08;
      try {
        const supabase = this.supabaseService.getServiceClient();
        const { data: weights } = await supabase
          .from('AiGeneratedContent')
          .select('GeneratedText')
          .eq('ContentType', 'rerank_weights')
          .order('CreatedAt', { ascending: false })
          .limit(1);
        if (Array.isArray(weights) && weights.length) {
          const w = JSON.parse(weights[0].GeneratedText || '{}');
          dynamicPriceBoost = typeof w.priceBoost === 'number' ? w.priceBoost : dynamicPriceBoost;
          dynamicHostBoost = typeof w.hostBoost === 'number' ? w.hostBoost : dynamicHostBoost;
        }
      } catch {}

      const rankedCandidates: RankedCandidate[] = data.ranked_candidates.map((candidate: any, index: number) => {
        const originalCandidate = request.candidates.find(c => c.id === candidate.id);
        const base = data.scores[index] as number;
        const title = (originalCandidate?.title || '').trim();
        const pricePresent = (originalCandidate?.price ?? 0) > 0;
        const source = (originalCandidate as any)?.metadata?.source || '';
        const sourceUrl = (originalCandidate as any)?.metadata?.sourceUrl || '';
        const host = (() => { try { return new URL(sourceUrl).hostname.replace(/^www\./,''); } catch { return ''; } })();
        const isReputable = this.reputableHosts.some(h => host.endsWith(h));

        // Clean title heuristic: fewer punctuation, reasonable length
        const punctuation = (title.match(/[!@#$%^&*()_+=\[\]{};:'",<>/?\\|`~]/g) || []).length;
        const cleanTitleBonus = Math.max(0, 1 - Math.min(1, punctuation / 10));
        const priceBonus = pricePresent ? dynamicPriceBoost : 0;
        const sourceBonus = isReputable ? dynamicHostBoost : 0;

        // Hybridize with vector similarity from upstream (if present)
        const vecCombined = Math.max(0, Math.min(1, Number(((originalCandidate as any)?.metadata?.combinedScore) ?? 0)));
        const imgSim = Math.max(0, Number(((originalCandidate as any)?.metadata?.imageSimilarity) ?? 0));
        const txtSim = Math.max(0, Number(((originalCandidate as any)?.metadata?.textSimilarity) ?? 0));
        const vecHybrid = Math.max(vecCombined, (0.6 * imgSim + 0.4 * txtSim));

        // Token overlap bonus between query and candidate text
        const candidateText = `${title} ${originalCandidate?.description || ''}`;
        const tokenOverlap = this.calculateBasicSimilarity(searchQuery, candidateText); // reuse simple overlap
        const tokenBonus = Math.min(0.10, tokenOverlap * 0.20);

        // 🎯 ENHANCED: Vector search is working well, give it more weight
        const aiWeight = 0.50;  // Reduced AI weight since it's making poor decisions
        const vecWeight = 0.50; // Equal weight to vector search which is more reliable
        
        // Extra boost for high vector scores (these are likely correct matches)
        const highVectorBonus = vecHybrid >= 0.60 ? 0.15 : 0; // Big boost for strong vector matches
        
        const fused = Math.min(1, (aiWeight * base) + (vecWeight * vecHybrid) + highVectorBonus);

        const adjusted = Math.min(1, fused + (cleanTitleBonus * 0.03) + priceBonus + sourceBonus + tokenBonus);

        return {
          ...originalCandidate,
          rank: index + 1,
          score: adjusted,
          explanation: this.generateScoreExplanation(adjusted)
        } as RankedCandidate;
      })
      // resort after adjustment with tie-break on vector score if available
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const bVec = Math.max(0, Number(((b as any)?.metadata?.combinedScore) ?? 0));
        const aVec = Math.max(0, Number(((a as any)?.metadata?.combinedScore) ?? 0));
        return bVec - aVec;
      })
      .map((c, i) => ({ ...c, rank: i + 1 }));

      const topScore = rankedCandidates[0]?.score || 0;
      const confidenceTier = this.determineConfidenceTier(topScore);
      const systemAction = this.determineSystemAction(confidenceTier, rankedCandidates.length);

      const rerankerResponse: RerankerResponse = {
        rankedCandidates,
        confidenceTier,
        topScore,
        systemAction,
        processingTimeMs: processingTime,
        metadata: {
          model: data.model,
          totalCandidates: request.candidates.length,
          queryLength: request.query.length
        }
      };

      // Track usage
      if (request.userId) {
        await this.aiUsageTracker.trackUsage({
          userId: request.userId,
          serviceType: 'embedding',
          modelName: 'qwen3-reranker',
          operation: 'rerank_candidates',
          inputTokens: this.estimateTokens(request.query, candidatesForReranker),
          metadata: {
            confidence_tier: confidenceTier,
            top_score: topScore,
            candidates_count: request.candidates.length
          }
        });
      }

      try {
        // Log to AiGeneratedContent for analytics/training
        const svc = this.supabaseService.getServiceClient();
        await svc.from('AiGeneratedContent').insert({
          UserId: request.userId || null,
          ContentType: 'rerank',
          SourceApi: 'ai-server',
          Prompt: searchQuery,
          GeneratedText: JSON.stringify(rerankerResponse),
          Metadata: {
            candidates: request.candidates?.length || 0,
            topScore,
            confidenceTier,
          },
          IsActive: false,
        });
      } catch (e) {
        this.logger.warn(`Failed to record rerank event: ${e?.message || e}`);
      }

      return rerankerResponse;

    } catch (error) {
      const processingTime = Date.now() - startTime;
      
      if (request.userId) {
        await this.aiUsageTracker.trackUsage({
          userId: request.userId,
          serviceType: 'embedding',
          modelName: 'qwen3-reranker',
          operation: 'rerank_candidates',
          inputTokens: 0,
          metadata: {
            error: error.message
          }
        });
      }

      this.logger.error('Failed to rerank candidates:', error);
      
      // Return fallback response
      return this.createFallbackResponse(request, processingTime);
    }
  }

  /**
   * Log a product match interaction for the training flywheel
   */
  async logMatchInteraction(interaction: MatchInteraction): Promise<string> {
    try {
      const supabase = this.supabaseService.getClient();

      // Calculate image hash for deduplication
      const imageHash = await this.calculateImageHash(interaction.imageUrl);

      // Prepare vectors (simplified - would need actual embeddings)
      const mockImageEmbedding = new Array(1664).fill(0.5);
      const mockTextEmbedding = new Array(1024).fill(0.5);

      // Log the match interaction
      const { data, error } = await supabase.rpc('log_product_match', {
        p_user_id: interaction.userId,
        p_image_url: interaction.imageUrl,
        p_image_hash: imageHash,
        p_image_embedding: mockImageEmbedding,
        p_text_query: interaction.query,
        p_text_embedding: mockTextEmbedding,
        p_candidates: interaction.candidates,
        p_vector_scores: interaction.candidates.map(() => 0.8), // Mock vector scores
        p_reranker_scores: interaction.rerankerResponse.rankedCandidates.map(c => c.score),
        p_confidence_tier: interaction.rerankerResponse.confidenceTier,
        p_top_score: interaction.rerankerResponse.topScore,
        p_system_action: interaction.rerankerResponse.systemAction,
        p_processing_time_ms: interaction.rerankerResponse.processingTimeMs
      });

      if (error) {
        this.logger.error('Failed to log match interaction:', error);
        throw error;
      }

      return data;

    } catch (error) {
      this.logger.error('Failed to log match interaction:', error);
      throw error;
    }
  }

  /**
   * Record user feedback for training data collection
   */
  async recordUserFeedback(
    matchId: string,
    userSelection?: number,
    userRejected: boolean = false,
    userFeedback?: string
  ): Promise<void> {
    try {
      const supabase = this.supabaseService.getClient();

      const { error } = await supabase.rpc('record_user_feedback', {
        p_match_id: matchId,
        p_user_selection: userSelection,
        p_user_rejected: userRejected,
        p_user_feedback: userFeedback
      });

      if (error) {
        this.logger.error('Failed to record user feedback:', error);
        throw error;
      }

      this.logger.log(`Recorded user feedback for match ${matchId}`);

    } catch (error) {
      this.logger.error('Failed to record user feedback:', error);
      throw error;
    }
  }

  /**
   * Get performance metrics for evaluation
   */
  async getPerformanceMetrics(templateName?: string, days: number = 7): Promise<any> {
    try {
      const supabase = this.supabaseService.getClient();

      // Get recent match interactions
      let matchQuery = supabase
        .from('ProductMatches')
        .select('*')
        .gte('CreatedAt', new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString());

      const { data: matches, error: matchError } = await matchQuery;
      if (matchError) throw matchError;

      // Calculate metrics
      const totalMatches = matches.length;
      const confidenceDistribution = {
        high: matches.filter(m => m.ConfidenceTier === 'high').length,
        medium: matches.filter(m => m.ConfidenceTier === 'medium').length,
        low: matches.filter(m => m.ConfidenceTier === 'low').length,
      };

      const userAcceptanceRate = matches.filter(m => 
        m.UserSelection !== null || m.FeedbackType === 'positive'
      ).length / totalMatches;

      const averageProcessingTime = matches.reduce((acc, m) => 
        acc + (m.ProcessingTimeMs || 0), 0
      ) / totalMatches;

      return {
        totalMatches,
        confidenceDistribution,
        userAcceptanceRate,
        averageProcessingTime,
        highConfidenceAccuracy: this.calculateTierAccuracy(matches, 'high'),
        mediumConfidenceAccuracy: this.calculateTierAccuracy(matches, 'medium'),
        period: `${days} days`,
        evaluatedAt: new Date().toISOString()
      };

    } catch (error) {
      this.logger.error('Failed to get performance metrics:', error);
      throw error;
    }
  }

  /**
   * Private helper methods
   */
  private determineConfidenceTier(score: number): 'high' | 'medium' | 'low' {
    // 🎯 UPDATED: Better no-match detection
    if (score < this.NO_MATCH_THRESHOLD) {
      return 'low'; // Force low confidence for poor matches
    } else if (score >= this.HIGH_CONFIDENCE_THRESHOLD) {
      return 'high';
    } else if (score >= this.MEDIUM_CONFIDENCE_THRESHOLD) {
      return 'medium';
    } else {
      return 'low';
    }
  }

  private determineSystemAction(
    confidenceTier: 'high' | 'medium' | 'low',
    candidateCount: number
  ): 'show_single_match' | 'show_multiple_candidates' | 'fallback_to_external' | 'fallback_to_manual' {
    if (confidenceTier === 'high' && candidateCount > 0) {
      return 'show_single_match';
    } else if (confidenceTier === 'medium' && candidateCount > 0) {
      return 'show_multiple_candidates';
    } else if (candidateCount === 0) {
      return 'fallback_to_manual';
    } else {
      return 'fallback_to_external';
    }
  }

  private generateScoreExplanation(
    score: number, 
    isActualProduct?: boolean, 
    retrievalChannels?: string
  ): string {
    let explanation = '';
    
    if (score >= 0.80) {
      explanation = 'Excellent match with high confidence';
    } else if (score >= 0.65) {
      explanation = 'Very good match with strong similarity';
    } else if (score >= 0.50) {
      explanation = 'Good match with moderate similarity';
    } else if (score >= 0.35) {
      explanation = 'Fair match with some similarity';
    } else {
      explanation = 'Low similarity match';
    }

    // Add context about product type and retrieval method
    if (isActualProduct) {
      explanation += ' (Product listing)';
    }
    
    if (retrievalChannels?.includes('dense+sparse')) {
      explanation += ' (Multi-channel match)';
    } else if (retrievalChannels?.includes('sparse')) {
      explanation += ' (Keyword match)';
    } else if (retrievalChannels?.includes('dense')) {
      explanation += ' (Visual match)';
    }

    return explanation;
  }

  private createFallbackResponse(request: RerankerRequest, processingTime: number): RerankerResponse {
    // Return candidates with basic scoring based on title similarity
    const rankedCandidates: RankedCandidate[] = request.candidates
      .map((candidate, index) => ({
        ...candidate,
        rank: index + 1,
        score: this.calculateBasicSimilarity(request.query, candidate.title),
        explanation: 'Fallback scoring due to reranker error'
      }))
      .sort((a, b) => b.score - a.score);

    const topScore = rankedCandidates[0]?.score || 0;

    return {
      rankedCandidates,
      confidenceTier: 'low',
      topScore,
      systemAction: 'fallback_to_external',
      processingTimeMs: processingTime,
      metadata: {
        model: 'fallback',
        totalCandidates: request.candidates.length,
        queryLength: request.query.length
      }
    };
  }

  private calculateBasicSimilarity(query: string, title: string): number {
    // Simple word overlap calculation
    const queryWords = query.toLowerCase().split(/\s+/);
    const titleWords = title.toLowerCase().split(/\s+/);
    
    const intersection = queryWords.filter(word => titleWords.includes(word));
    return intersection.length / Math.max(queryWords.length, titleWords.length);
  }

  private estimateTokens(query: string, candidates: any[]): number {
    const queryTokens = Math.ceil(query.length / 4); // Rough estimate
    const candidateTokens = candidates.reduce((acc, candidate) => {
      const text = `${candidate.title || ''} ${candidate.description || ''}`;
      return acc + Math.ceil(text.length / 4);
    }, 0);
    
    return queryTokens + candidateTokens;
  }

  private async calculateImageHash(imageUrl: string): Promise<string> {
    // Simple hash based on URL for now
    // In production, you'd want to use actual image content hashing
    const crypto = require('crypto');
    return crypto.createHash('md5').update(imageUrl).digest('hex');
  }

  private calculateTierAccuracy(matches: any[], tier: string): number {
    const tierMatches = matches.filter(m => m.ConfidenceTier === tier);
    if (tierMatches.length === 0) return 0;
    
    const correctMatches = tierMatches.filter(m => m.FeedbackType === 'positive');
    return correctMatches.length / tierMatches.length;
  }
} 