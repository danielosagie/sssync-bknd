import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EmbeddingService } from './embedding.service';
import { VectorSearchService } from './vector-search.service';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [ConfigModule, CommonModule],
  providers: [EmbeddingService, VectorSearchService],
  exports: [EmbeddingService, VectorSearchService],
})
export class EmbeddingModule {} 