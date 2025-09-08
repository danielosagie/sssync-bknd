import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface FastTextCandidate {
  id: string;
  title: string;
  description?: string;
  vectorScore: number;
  metadata?: any;
}

export interface FastTextRerankerRequest {
  ocrText: string; // Primary ranking signal
  textQuery?: string; // Secondary signal
  candidates: FastTextCandidate[];
  maxResults?: number; // Default: 10
}

export interface FastTextRerankerResult {
  rankedCandidates: FastTextCandidate[];
  topScore: number;
  confidenceTier: 'high' | 'medium' | 'low';
  processingTimeMs: number;
  rankingMethod: 'exact_match' | 'semantic_similarity' | 'fuzzy_match' | 'vector_fallback';
}

@Injectable()
export class FastTextRerankerService {
  private readonly logger = new Logger(FastTextRerankerService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * 🚀 FAST Pipeline A Reranker: OCR-driven, text-only, <100ms
   * 
   * Strategy:
   * 1. Exact match on OCR text (highest confidence)
   * 2. Fuzzy/substring matching (medium confidence)  
   * 3. Vector similarity fallback (lower confidence)
   */
  async rerankCandidates(request: FastTextRerankerRequest): Promise<FastTextRerankerResult> {
    const startTime = Date.now();
    const { ocrText, textQuery, candidates, maxResults = 10 } = request;
    
    this.logger.log(`[FastTextReranker] Processing ${candidates.length} candidates with OCR: "${ocrText.substring(0, 50)}..."`);

    try {
      // 🎯 Step 1: Extract key terms from OCR text
      const ocrKeywords = this.extractKeywords(ocrText);
      const queryKeywords = textQuery ? this.extractKeywords(textQuery) : [];
      
      this.logger.debug(`[FastTextReranker] OCR keywords: [${ocrKeywords.join(', ')}]`);

      // 🎯 Step 2: Score each candidate using multiple fast methods
      const scoredCandidates = candidates.map((candidate, index) => {
        const candidateText = `${candidate.title} ${candidate.description || ''}`.toLowerCase();
        
        // Method 1: Exact keyword matches (fastest, highest confidence)
        const exactMatches = this.countExactMatches(ocrKeywords, candidateText);
        const exactScore = exactMatches / Math.max(ocrKeywords.length, 1);

        // Booster: if candidate text contains the exact OCR key entity tokens (e.g., card name like "machamp"), strong boost
        const entityBoost = this.containsEntityToken(ocrKeywords, candidateText) ? 0.2 : 0.0;
        
        // Method 2: Fuzzy/substring matches (fast, medium confidence)
        const fuzzyScore = this.calculateFuzzyScore(ocrKeywords, candidateText);
        
        // Method 3: Title similarity boost
        const titleScore = this.calculateTitleSimilarity(ocrText, candidate.title);
        
        // Method 4: Use vector score as base signal
        const vectorScore = candidate.vectorScore || 0;
        
        // 🎯 Weighted combination - OCR-driven
        const finalScore = (
          exactScore * 0.5 +        // Exact matches most important
          fuzzyScore * 0.25 +       // Fuzzy matches second
          titleScore * 0.15 +       // Title similarity third
          vectorScore * 0.1         // Vector as baseline
        ) + entityBoost;            // Add entity boost
        
        // Determine ranking method for transparency
        let rankingMethod: FastTextRerankerResult['rankingMethod'];
        if (exactScore > 0.3) {
          rankingMethod = 'exact_match';
        } else if (fuzzyScore > 0.4) {
          rankingMethod = 'fuzzy_match';
        } else if (titleScore > 0.6) {
          rankingMethod = 'semantic_similarity';
        } else {
          rankingMethod = 'vector_fallback';
        }

        return {
          ...candidate,
          rerankerScore: finalScore,
          exactMatchScore: exactScore,
          fuzzyScore,
          titleScore,
          rankingMethod,
          debugInfo: {
            exactMatches,
            ocrKeywords: ocrKeywords.length,
            candidateText: candidateText.substring(0, 100)
          }
        };
      });

      // 🎯 Step 3: Sort by final score and take top results
      const rankedCandidates = scoredCandidates
        .sort((a, b) => b.rerankerScore - a.rerankerScore)
        .slice(0, maxResults);

      const topScore = rankedCandidates[0]?.rerankerScore || 0;
      
      // 🎯 Step 4: Determine confidence tier
      let confidenceTier: 'high' | 'medium' | 'low';
      if (topScore >= 0.6) {
        confidenceTier = 'high';
      } else if (topScore >= 0.3) {
        confidenceTier = 'medium';
      } else {
        confidenceTier = 'low';
      }

      const processingTimeMs = Date.now() - startTime;

      // 🎯 Step 5: Log results for debugging
      this.logger.log(`[FastTextReranker] Completed in ${processingTimeMs}ms, confidence: ${confidenceTier}, top score: ${topScore.toFixed(4)}`);
      this.logger.log(`[FastTextReranker] Top 3 results:`);
      rankedCandidates.slice(0, 3).forEach((candidate: any, index: number) => {
        this.logger.log(`  ${index + 1}. "${candidate.title.substring(0, 40)}..." - Score: ${candidate.rerankerScore.toFixed(4)} (${candidate.rankingMethod})`);
      });

      return {
        rankedCandidates: rankedCandidates.map(({ rerankerScore, exactMatchScore, fuzzyScore, titleScore, rankingMethod, debugInfo, ...candidate }) => candidate),
        topScore,
        confidenceTier,
        processingTimeMs,
        rankingMethod: rankedCandidates[0]?.rankingMethod || 'vector_fallback'
      };

    } catch (error) {
      this.logger.error(`[FastTextReranker] Error: ${error.message}`, error.stack);
      
      // Fallback: return original order with vector scores
      const processingTimeMs = Date.now() - startTime;
      return {
        rankedCandidates: candidates.slice(0, maxResults),
        topScore: candidates[0]?.vectorScore || 0,
        confidenceTier: 'low',
        processingTimeMs,
        rankingMethod: 'vector_fallback'
      };
    }
  }

  /**
   * Extract meaningful keywords from text (OCR or query)
   */
  private extractKeywords(text: string): string[] {
    if (!text) return [];
    
    // Normalize and split
    const normalized = text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    const words = normalized.split(' ');
    
    // Filter out stop words and short words
    const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'can', 'may', 'might']);
    
    // Keep numbers (e.g., 220, 140) and key alphas
    return words
      .filter(word => word.length >= 2 && !stopWords.has(word))
      .slice(0, 10); // Limit to top 10 keywords for performance
  }

  /**
   * Count exact keyword matches in candidate text
   */
  private countExactMatches(keywords: string[], candidateText: string): number {
    return keywords.filter(keyword => candidateText.includes(keyword)).length;
  }

  /**
   * Calculate fuzzy/substring similarity score
   */
  private calculateFuzzyScore(keywords: string[], candidateText: string): number {
    if (keywords.length === 0) return 0;
    
    let totalScore = 0;
    
    keywords.forEach(keyword => {
      // Exact match
      if (candidateText.includes(keyword)) {
        totalScore += 1.0;
      }
      // Partial match (substring of keyword found)
      else if (keyword.length >= 4) {
        const partialMatch = candidateText.includes(keyword.substring(0, keyword.length - 1)) ||
                            candidateText.includes(keyword.substring(1));
        if (partialMatch) {
          totalScore += 0.6;
        }
      }
      // Character similarity for very short keywords
      else {
        const similarity = this.calculateCharacterSimilarity(keyword, candidateText);
        totalScore += similarity * 0.3;
      }
    });
    
    return totalScore / keywords.length;
  }

  /**
   * Calculate title-specific similarity
   */
  private calculateTitleSimilarity(ocrText: string, title: string): number {
    if (!ocrText || !title) return 0;
    
    const normalizedOcr = ocrText.toLowerCase().replace(/[^\w\s]/g, ' ');
    const normalizedTitle = title.toLowerCase().replace(/[^\w\s]/g, ' ');
    
    // Simple word overlap similarity
    const ocrWords = new Set(normalizedOcr.split(/\s+/).filter(w => w.length >= 2));
    const titleWords = new Set(normalizedTitle.split(/\s+/).filter(w => w.length >= 2));
    
    const intersection = new Set([...ocrWords].filter(x => titleWords.has(x)));
    const union = new Set([...ocrWords, ...titleWords]);
    
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  /**
   * Entity token check: looks for strong name tokens (first 3 keywords) in candidate text
   */
  private containsEntityToken(keywords: string[], candidateText: string): boolean {
    if (!keywords || keywords.length === 0) return false;
    const top = keywords.slice(0, 3);
    return top.some(k => candidateText.includes(k));
  }

  /**
   * Simple character-level similarity for short text
   */
  private calculateCharacterSimilarity(text1: string, text2: string): number {
    if (!text1 || !text2) return 0;
    
    const shorter = text1.length <= text2.length ? text1 : text2;
    const longer = text1.length > text2.length ? text1 : text2;
    
    if (longer.includes(shorter)) {
      return shorter.length / longer.length;
    }
    
    return 0;
  }
}
