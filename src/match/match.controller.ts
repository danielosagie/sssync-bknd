import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { FuzzyMatcherService } from './fuzzy-matcher.service';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';

@Controller('match')
@UseGuards(SupabaseAuthGuard)
export class MatchController {
  constructor(private readonly fuzzyMatcher: FuzzyMatcherService) {}

  @Get('candidates')
  async getCandidates(
    @Query('userId') userId: string,
    @Query('title') title: string,
    @Query('limit') limit = '10'
  ) {
    const n = parseInt(limit, 10) || 10;
    const list = await this.fuzzyMatcher.findTitleCandidates(userId, title, n);
    return { candidates: list };
  }
}











