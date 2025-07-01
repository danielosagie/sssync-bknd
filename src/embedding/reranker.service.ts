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
}

export interface RerankerRequest {
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
  systemAction: 'show_single_match' | 'show_multiple_candidates' | 'fallback_to_external';
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

  // Confidence thresholds for tier classification
  private readonly HIGH_CONFIDENCE_THRESHOLD = 0.95;
  private readonly MEDIUM_CONFIDENCE_THRESHOLD = 0.60;
  
  constructor(
    private readonly configService: ConfigService,
    private readonly supabaseService: SupabaseService,
    private readonly aiUsageTracker: AiUsageTrackerService
  ) {
    this.aiServerUrl = this.configService.get<string>('AI_SERVER_URL') || 'http://localhost:8000';
  }

  /**
   * Rerank product candidates and determine confidence tier
   */
  async rerankCandidates(request: RerankerRequest): Promise<RerankerResponse> {
    const startTime = Date.now();
    
    try {
      // Prepare candidates for reranking
      const candidatesForReranker = request.candidates.map(candidate => ({
        id: candidate.id,
        title: candidate.title,
        description: candidate.description || '',
        price: candidate.price,
        brand: candidate.brand,
        category: candidate.category,
        business_template: candidate.businessTemplate,
        metadata: candidate.metadata
      }));

      // Call the AI server reranker endpoint
      const response = await fetch(`${this.aiServerUrl}/rerank`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: request.query,
          candidates: candidatesForReranker,
          top_k: request.maxCandidates || 10
        }),
      });

      if (!response.ok) {
        throw new Error(`Reranker API error: ${response.statusText}`);
      }

      const data = await response.json();
      const processingTime = Date.now() - startTime;

      // Build ranked candidates with original data
      const rankedCandidates: RankedCandidate[] = data.ranked_candidates.map((candidate: any, index: number) => {
        const originalCandidate = request.candidates.find(c => c.id === candidate.id);
        return {
          ...originalCandidate,
          rank: index + 1,
          score: data.scores[index],
          explanation: this.generateScoreExplanation(data.scores[index])
        };
      });

      const topScore = data.scores[0] || 0;
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
      const mockImageEmbedding = new Array(768).fill(0.5);
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
    if (score >= this.HIGH_CONFIDENCE_THRESHOLD) {
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
  ): 'show_single_match' | 'show_multiple_candidates' | 'fallback_to_external' {
    switch (confidenceTier) {
      case 'high':
        return 'show_single_match';
      case 'medium':
        return candidateCount > 1 ? 'show_multiple_candidates' : 'fallback_to_external';
      case 'low':
      default:
        return 'fallback_to_external';
    }
  }

  private generateScoreExplanation(score: number): string {
    if (score >= 0.95) {
      return 'Excellent match with high confidence';
    } else if (score >= 0.85) {
      return 'Very good match with strong similarity';
    } else if (score >= 0.70) {
      return 'Good match with moderate similarity';
    } else if (score >= 0.60) {
      return 'Fair match with some similarity';
    } else {
      return 'Low similarity match';
    }
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