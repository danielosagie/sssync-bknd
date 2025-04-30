import { Module } from '@nestjs/common';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';
import { ImageRecognitionService } from './image-recognition/image-recognition.service';
import { AiGenerationService } from './ai-generation/ai-generation.service';
import { ConfigModule } from '@nestjs/config';
import { CommonModule } from '../common/common.module';
import { PlatformConnectionsModule } from '../platform-connections/platform-connections.module';
import { SyncEngineModule } from '../sync-engine/sync-engine.module';

@Module({
  imports: [
    ConfigModule,
    CommonModule,
    PlatformConnectionsModule,
    SyncEngineModule,
  ],
  controllers: [ProductsController],
  providers: [ProductsService, ImageRecognitionService, AiGenerationService],
})
export class ProductsModule {}
