import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from './supabase.service';

export interface AiUsageMetadata {
  productId?: string;
  variantId?: string;
  platform?: string;
  imageUrl?: string;
  operation?: string;
  [key: string]: any;
}

export interface TrackUsageParams {
  userId: string;
  serviceType: 'embedding' | 'generation' | 'firecrawl' | 'serpapi' | 'firecrawl_search' | 'firecrawl_scrape' | 'siglip_embedding' | 'qwen3_embedding';
  modelName: string;
  operation: string;
  inputTokens?: number;
  outputTokens?: number;
  requestCount?: number;
  metadata?: AiUsageMetadata;
}

export interface UserUsageLimit {
  serviceType: string;
  currentUsage: number;
  limitAmount: number;
  isOverLimit: boolean;
  costThisMonth: number;
}

@Injectable()
export class AiUsageTrackerService {
  private readonly logger = new Logger(AiUsageTrackerService.name);

  constructor(private readonly supabaseService: SupabaseService) {}

  /**
   * Track AI usage for billing purposes
   */
  async trackUsage(params: TrackUsageParams): Promise<string> {
    try {
      const supabase = this.supabaseService.getClient();

      const { data, error } = await supabase.rpc('track_ai_usage', {
        p_user_id: params.userId,
        p_service_type: params.serviceType,
        p_model_name: params.modelName,
        p_operation: params.operation,
        p_input_tokens: params.inputTokens || 0,
        p_output_tokens: params.outputTokens || 0,
        p_request_count: params.requestCount || 1,
        p_metadata: params.metadata || {}
      });

      if (error) {
        this.logger.error('Failed to track AI usage:', error);
        throw error;
      }

      this.logger.log(`Tracked ${params.serviceType} usage for user ${params.userId}: ${params.operation}`);
      return data;
    } catch (error) {
      this.logger.error('Error tracking AI usage:', error);
      throw error;
    }
  }

  /**
   * Track embedding generation usage
   */
  async trackEmbeddingUsage(
    userId: string,
    textLength: number,
    operation: 'embed_product' | 'embed_search' = 'embed_product',
    metadata?: AiUsageMetadata
  ): Promise<void> {
    // Estimate tokens (rough approximation: 1 token ≈ 4 characters)
    const estimatedTokens = Math.ceil(textLength / 4);

    await this.trackUsage({
      userId,
      serviceType: 'embedding',
      modelName: 'qwen3-0.6b',
      operation,
      inputTokens: estimatedTokens,
      outputTokens: 0,
      metadata
    });
  }

  /**
   * Track LLM generation usage (Groq)
   */
  async trackGenerationUsage(
    userId: string,
    inputTokens: number,
    outputTokens: number,
    operation: 'generate_details' | 'analyze_image' = 'generate_details',
    metadata?: AiUsageMetadata
  ): Promise<void> {
    await this.trackUsage({
      userId,
      serviceType: 'generation',
      modelName: 'groq-llama',
      operation,
      inputTokens,
      outputTokens,
      metadata
    });
  }

  /**
   * Track Firecrawl usage
   */
  async trackFirecrawlUsage(
    userId: string,
    operation: 'scrape_url' | 'search_web' | 'extract_data',
    requestCount: number = 1,
    metadata?: AiUsageMetadata
  ): Promise<void> {
    await this.trackUsage({
      userId,
      serviceType: 'firecrawl',
      modelName: 'firecrawl-scrape',
      operation,
      requestCount,
      metadata
    });
  }

  /**
   * Track SerpAPI usage
   */
  async trackSerpApiUsage(
    userId: string,
    operation: 'visual_search',
    metadata?: AiUsageMetadata
  ): Promise<void> {
    await this.trackUsage({
      userId,
      serviceType: 'serpapi',
      modelName: 'serpapi-lens',
      operation,
      requestCount: 1,
      metadata
    });
  }

  /**
   * Check if user is within usage limits
   */
  async checkUserLimits(userId: string, serviceType?: string): Promise<UserUsageLimit[]> {
    try {
      const supabase = this.supabaseService.getClient();

      const { data, error } = await supabase.rpc('check_user_ai_limits', {
        p_user_id: userId,
        p_service_type: serviceType || null
      });

      if (error) {
        this.logger.error('Failed to check user limits:', error);
        throw error;
      }

      return data.map((row: any) => ({
        serviceType: row.service_type,
        currentUsage: parseInt(row.current_usage),
        limitAmount: parseInt(row.limit_amount),
        isOverLimit: row.is_over_limit,
        costThisMonth: parseFloat(row.cost_this_month)
      }));
    } catch (error) {
      this.logger.error('Error checking user limits:', error);
      throw error;
    }
  }

  /**
   * Get user's monthly usage breakdown
   */
  async getUserMonthlyUsage(
    userId: string, 
    year?: number, 
    month?: number
  ): Promise<{
    serviceType: string;
    totalTokens: number;
    totalRequests: number;
    totalCostUsd: number;
  }[]> {
    try {
      const supabase = this.supabaseService.getClient();

      const { data, error } = await supabase.rpc('get_user_monthly_usage', {
        p_user_id: userId,
        p_year: year || new Date().getFullYear(),
        p_month: month || new Date().getMonth() + 1
      });

      if (error) {
        this.logger.error('Failed to get monthly usage:', error);
        throw error;
      }

      return data.map((row: any) => ({
        serviceType: row.service_type,
        totalTokens: parseInt(row.total_tokens),
        totalRequests: parseInt(row.total_requests),
        totalCostUsd: parseFloat(row.total_cost_usd)
      }));
    } catch (error) {
      this.logger.error('Error getting monthly usage:', error);
      throw error;
    }
  }

  /**
   * Check if user can perform an operation (respects limits)
   */
  async canUserPerformOperation(
    userId: string, 
    serviceType: string,
    estimatedTokens: number = 1000
  ): Promise<{ allowed: boolean; reason?: string; currentUsage?: number; limit?: number }> {
    try {
      const limits = await this.checkUserLimits(userId, serviceType);
      
      if (limits.length === 0) {
        // No limits found, allow operation (new user or service type)
        return { allowed: true };
      }

      const limit = limits[0];
      
      if (limit.isOverLimit) {
        return {
          allowed: false,
          reason: `Monthly limit exceeded for ${serviceType}`,
          currentUsage: limit.currentUsage,
          limit: limit.limitAmount
        };
      }

      // Check if this operation would exceed the limit
      if (limit.currentUsage + estimatedTokens > limit.limitAmount) {
        return {
          allowed: false,
          reason: `Operation would exceed monthly limit for ${serviceType}`,
          currentUsage: limit.currentUsage,
          limit: limit.limitAmount
        };
      }

      return { allowed: true };
    } catch (error) {
      this.logger.error('Error checking operation permissions:', error);
      // Fail open - allow operation if we can't check limits
      return { allowed: true };
    }
  }

  /**
   * Get cost estimate for an operation
   */
  async estimateOperationCost(
    serviceType: string,
    modelName: string,
    operation: string,
    inputTokens: number = 0,
    outputTokens: number = 0,
    requestCount: number = 1
  ): Promise<{ costUsd: number; breakdown: string }> {
    try {
      const supabase = this.supabaseService.getClient();

      const { data: pricing, error } = await supabase
        .from('AiServicePricing')
        .select('*')
        .eq('ServiceType', serviceType)
        .eq('ModelName', modelName)
        .eq('Operation', operation)
        .eq('IsActive', true)
        .single();

      if (error || !pricing) {
        return { costUsd: 0, breakdown: 'Pricing not found' };
      }

      let costUsd = 0;
      let breakdown = '';

      if (pricing.PricingType === 'per_token') {
        const inputCost = inputTokens * parseFloat(pricing.InputPriceUsd);
        const outputCost = outputTokens * parseFloat(pricing.OutputPriceUsd);
        costUsd = inputCost + outputCost;
        breakdown = `${inputTokens} input tokens × $${pricing.InputPriceUsd} + ${outputTokens} output tokens × $${pricing.OutputPriceUsd}`;
      } else if (pricing.PricingType === 'per_request') {
        costUsd = requestCount * parseFloat(pricing.BasePriceUsd);
        breakdown = `${requestCount} requests × $${pricing.BasePriceUsd}`;
      }

      return { costUsd, breakdown };
    } catch (error) {
      this.logger.error('Error estimating operation cost:', error);
      return { costUsd: 0, breakdown: 'Error calculating cost' };
    }
  }
} 