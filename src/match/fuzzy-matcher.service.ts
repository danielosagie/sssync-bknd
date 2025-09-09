import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';

@Injectable()
export class FuzzyMatcherService {
  private readonly logger = new Logger(FuzzyMatcherService.name);

  constructor(private readonly supabaseService: SupabaseService) {}

  async findTitleCandidates(userId: string, title: string, limit = 10): Promise<Array<{ variantId: string; title: string; sku: string | null; similarity: number }>> {
    const supabase = this.supabaseService.getClient();
    const { data, error } = await supabase.rpc('find_similar_variants', { p_user_id: userId, p_title: title, p_limit: limit });
    if (error) {
      this.logger.error(`findTitleCandidates RPC failed: ${error.message}`);
      return [];
    }
    return (data || []).map((row: any) => ({ variantId: row.variant_id, title: row.title, sku: row.sku, similarity: row.similarity }));
  }
}











