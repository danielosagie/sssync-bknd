import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CommonModule } from '../common/common.module';
import { MatchModule } from '../match/match.module';
import { IngestService } from './ingest.service';
import { IngestController } from './ingest.controller';
import { CsvMatchingProcessor } from './csv-matching.processor';

@Module({
  imports: [
    CommonModule,
    MatchModule,
    BullModule.registerQueue({
      name: 'csv-matching',
    }),
  ],
  providers: [IngestService, CsvMatchingProcessor],
  controllers: [IngestController],
  exports: [IngestService],
})
export class IngestModule {}


