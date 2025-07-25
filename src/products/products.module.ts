import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { CommonModule } from '../common/common.module';
import { CanonicalDataModule } from '../canonical-data/canonical-data.module';
import { PlatformProductMappingsModule } from '../platform-product-mappings/platform-product-mappings.module';
import { PlatformConnectionsModule } from '../platform-connections/platform-connections.module';
import { PlatformAdaptersModule } from '../platform-adapters/platform-adapters.module';
import { ImageRecognitionService } from './image-recognition/image-recognition.service';
import { AiGenerationService } from './ai-generation/ai-generation.service';
import { CrossAccountSyncService } from './cross-account-sync.service';
import { ActivityLogService } from '../common/activity-log.service';
import { FirecrawlService } from './firecrawl.service';
import { ProductRecognitionService } from './product-recognition.service';
import { ProductOrchestratorService } from './product-orchestrator.service';
import { EmbeddingModule } from '../embedding/embedding.module';
import { RerankerService } from '../embedding/reranker.service';

@Module({
  imports: [
    ConfigModule,
    CommonModule,
    CanonicalDataModule,
    PlatformProductMappingsModule,
    forwardRef(() => PlatformConnectionsModule),
    forwardRef(() => PlatformAdaptersModule),
    EmbeddingModule,
  ],
  controllers: [ProductsController],
  providers: [
    ProductsService, 
    ImageRecognitionService, 
    AiGenerationService, 
    CrossAccountSyncService, 
    ActivityLogService, 
    FirecrawlService,
    ProductRecognitionService,
    ProductOrchestratorService,
    RerankerService,
  ],
  exports: [
    ProductsService, 
    ImageRecognitionService, 
    AiGenerationService, 
    CrossAccountSyncService, 
    ActivityLogService,
    ProductRecognitionService,
    ProductOrchestratorService,
  ],
})
export class ProductsModule {}
