import { Module } from '@nestjs/common';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';
import { ImageRecognitionService } from './image-recognition/image-recognition.service';
import { AiGenerationService } from './ai-generation/ai-generation.service';
import { ConfigModule } from '@nestjs/config';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [
    ConfigModule,
    CommonModule,
  ],
  controllers: [ProductsController],
  providers: [ProductsService, ImageRecognitionService, AiGenerationService],
})
export class ProductsModule {}
