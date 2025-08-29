import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BackfillOrchestratorService } from './backfill-orchestrator.service';
import { BackfillController } from './backfill.controller';
import { BackfillJobProcessor } from './processors/backfill-job.processor';
import { CommonModule } from '../common/common.module';
import { PlatformConnectionsModule } from '../platform-connections/platform-connections.module';
import { ProductsModule } from '../products/products.module';

@Module({
  imports: [
    CommonModule,
    PlatformConnectionsModule,
    ProductsModule,
    BullModule.registerQueue({
      name: 'backfill-jobs',
    }),
  ],
  controllers: [BackfillController],
  providers: [
    BackfillOrchestratorService,
    BackfillJobProcessor,
  ],
  exports: [
    BackfillOrchestratorService,
  ],
})
export class BackfillModule {}
