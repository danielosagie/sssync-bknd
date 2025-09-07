import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EmbeddingService } from './embedding.service';
import { VectorSearchService } from './vector-search.service';
import { CommonModule } from '../common/common.module';
import { OcrService } from 'src/common/ocr.service';

@Module({
  imports: [ConfigModule, CommonModule],
  providers: [EmbeddingService, VectorSearchService, OcrService],
  exports: [EmbeddingService, VectorSearchService],
})
export class EmbeddingModule {} 