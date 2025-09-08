import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EmbeddingService } from './embedding.service';
import { VectorSearchService } from './vector-search.service';
import { GroqSmartPickerService } from './groq-smart-picker.service';
import { FastTextRerankerService } from './fast-text-reranker.service';
import { CommonModule } from '../common/common.module';
import { OcrService } from 'src/common/ocr.service';

@Module({
  imports: [ConfigModule, CommonModule],
  providers: [EmbeddingService, VectorSearchService, GroqSmartPickerService, FastTextRerankerService, OcrService],
  exports: [EmbeddingService, VectorSearchService, GroqSmartPickerService, FastTextRerankerService],
})
export class EmbeddingModule {} 