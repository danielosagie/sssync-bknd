import { Module } from '@nestjs/common';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';
import { ImageRecognitionService } from './image-recognition/image-recognition.service';
import { AiGenerationService } from './ai-generation/ai-generation.service';

@Module({
  providers: [ProductsService, ImageRecognitionService, AiGenerationService],
  controllers: [ProductsController]
})
export class ProductsModule {}
