import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { FuzzyMatcherService } from './fuzzy-matcher.service';
import { MatchController } from './match.controller';

@Module({
  imports: [CommonModule],
  providers: [FuzzyMatcherService],
  controllers: [MatchController],
  exports: [FuzzyMatcherService],
})
export class MatchModule {}






