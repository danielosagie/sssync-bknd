import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmbeddingService, ProductMatch } from './embedding.service';

export interface VectorSearchOptions {
  limit?: number;
  threshold?: number;
  includeMetadata?: boolean;
  filters?: {
    userId?: string;
    category?: string;
    priceRange?: { min?: number; max?: number };
    brand?: string;
    platformType?: string;
  };
}

// Define the interface locally since it's specific to this service
export interface SimilaritySearchResult {
  productId: string;
  variantId: string;
  title: string;
  description?: string;
  similarity: number;
  metadata?: any;
}

@Injectable()
export class VectorSearchService {
  private readonly logger = new Logger(VectorSearchService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly embeddingService: EmbeddingService,
  ) {}

  /**
   * Search for similar products using text query
   */
  async searchByText(
    query: string,
    options: {
      limit?: number;
      threshold?: number;
      businessTemplate?: string;
      userId?: string;
    } = {}
  ): Promise<SimilaritySearchResult[]> {
    try {
      this.logger.log(`Searching for products similar to: "${query}"`);

      // Generate embedding for the search query
      const textEmbedding = await this.embeddingService.generateTextEmbedding({
        title: query,
        businessTemplate: options.businessTemplate
      }, options.userId);

      // Search for similar products
      const matches = await this.embeddingService.searchSimilarProducts({
        textEmbedding,
        businessTemplate: options.businessTemplate,
        limit: options.limit,
        threshold: options.threshold
      });

      // Convert to SimilaritySearchResult format
      return matches.map(match => ({
        productId: match.productId,
        variantId: match.variantId,
        title: match.title,
        description: match.description,
        similarity: match.combinedScore,
        metadata: {
          imageSimilarity: match.imageSimilarity,
          textSimilarity: match.textSimilarity,
          businessTemplate: match.businessTemplate
        }
      }));

    } catch (error) {
      this.logger.error(`Failed to search by text: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Search for similar products using image
   */
  async searchByImage(
    imageInput: { imageUrl?: string; imageBase64?: string },
    imageEmbedding: number[],
  
    options: {
      limit?: number;
      threshold?: number;
      businessTemplate?: string;
      userId?: string;
    } = {}
  ): Promise<SimilaritySearchResult[]> {
    try {
      this.logger.log('Searching for products by image similarity');

      // Generate embedding for the image
      
      /*
      const imageEmbedding = await this.embeddingService.generateImageEmbedding(
        imageInput,
        options.userId
      );
      */

      // Search for similar products
      const matches = await this.embeddingService.searchSimilarProducts({
        imageEmbedding,
        businessTemplate: options.businessTemplate,
        limit: options.limit,
        threshold: options.threshold
      });

      // Convert to SimilaritySearchResult format
      return matches.map(match => ({
        productId: match.productId,
        variantId: match.variantId,
        title: match.title,
        description: match.description,
        similarity: match.combinedScore,
        metadata: {
          imageSimilarity: match.imageSimilarity,
          textSimilarity: match.textSimilarity,
          businessTemplate: match.businessTemplate
        }
      }));

    } catch (error) {
      this.logger.error(`Failed to search by image: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Hybrid search combining text and image
   */
  async hybridSearch(
    query: string,
    imageInput: { imageUrl?: string; imageBase64?: string },
    options: {
      limit?: number;
      threshold?: number;
      businessTemplate?: string;
      imageWeight?: number;
      textWeight?: number;
      userId?: string;
    } = {}
  ): Promise<SimilaritySearchResult[]> {
    try {
      this.logger.log(`Performing hybrid search with query: "${query}" and image`);

      // Generate both embeddings
      const [textEmbedding, imageEmbedding] = await Promise.all([
        this.embeddingService.generateTextEmbedding({
          title: query,
          businessTemplate: options.businessTemplate
        }, options.userId),
        this.embeddingService.generateImageEmbedding(imageInput, options.userId)
      ]);

      // Search for similar products with both embeddings
      const matches = await this.embeddingService.searchSimilarProducts({
        textEmbedding,
        imageEmbedding,
        businessTemplate: options.businessTemplate,
        imageWeight: options.imageWeight || 0.6,
        textWeight: options.textWeight || 0.4,
        limit: options.limit,
        threshold: options.threshold
      });

      // Convert to SimilaritySearchResult format
      return matches.map(match => ({
        productId: match.productId,
        variantId: match.variantId,
        title: match.title,
        description: match.description,
        similarity: match.combinedScore,
        metadata: {
          imageSimilarity: match.imageSimilarity,
          textSimilarity: match.textSimilarity,
          businessTemplate: match.businessTemplate
        }
      }));

    } catch (error) {
      this.logger.error(`Failed to perform hybrid search: ${error.message}`, error.stack);
      throw error;
    }
  }
} 