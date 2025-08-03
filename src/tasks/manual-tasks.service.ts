import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';
import { EmbeddingService } from '../embedding/embedding.service';

@Injectable()
export class ManualTasksService {
  private readonly logger = new Logger(ManualTasksService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly embeddingService: EmbeddingService,
  ) {}

  /**
   * Iterates through products and generates embeddings for those missing them.
   */
  async backfillProductEmbeddings(batchSize: number = 100): Promise<void> {
    this.logger.log(`Starting product embeddings backfill with batch size: ${batchSize}`);
    
    // Get products that don't have embeddings
    const { data: products, error } = await this.supabaseService.getClient()
      .from('products')
      .select('id, title, description, image_url, variant_id')
      .is('embeddings_generated', false)
      .limit(batchSize);

    if (error) {
      this.logger.error('Failed to fetch products for backfill:', error);
      throw new Error(`Failed to fetch products: ${error.message}`);
    }

    if (!products || products.length === 0) {
      this.logger.log('No products found that need embeddings');
      return;
    }

    this.logger.log(`Found ${products.length} products needing embeddings`);

    for (const product of products) {
      try {
        // Check if embeddings already exist (safety check)
        const { data: existingEmbedding, error: checkError } = await this.supabaseService.getClient()
          .from('product_embeddings')
          .select('id')
          .eq('product_id', product.id)
          .single();

        if (existingEmbedding) {
          this.logger.log(`Embeddings already exist for product ${product.id}, skipping`);
          continue;
        }

        // Generate embeddings
        this.logger.log(`Generating embeddings for product: ${product.title}`);
        
        let imageEmbedding: number[] | null = null;
        let textEmbedding: number[] | null = null;

        // Generate image embedding if image URL exists
        if (product.image_url) {
          try {
            imageEmbedding = await this.embeddingService.generateImageEmbedding({
              imageUrl: product.image_url
            });
          } catch (error) {
            this.logger.warn(`Failed to generate image embedding for product ${product.id}:`, error.message);
          }
        }

        // Generate text embedding
        const textContent = [product.title, product.description].filter(Boolean).join(' ');
        if (textContent) {
          try {
            textEmbedding = await this.embeddingService.generateTextEmbedding({
              title: product.title,
              description: product.description
            });
          } catch (error) {
            this.logger.warn(`Failed to generate text embedding for product ${product.id}:`, error.message);
          }
        }

        // Store embeddings if at least one was generated
        if (imageEmbedding || textEmbedding) {
          await this.embeddingService.storeProductEmbedding({
            productId: product.id,
            productVariantId: product.variant_id,
            imageEmbedding: imageEmbedding || undefined, // Convert null to undefined
            textEmbedding: textEmbedding || undefined,   // Convert null to undefined
            imageUrl: product.image_url,
            productText: textContent,
            sourceType: 'backfill',
            businessTemplate: 'electronics'
          });

          this.logger.log(`✅ Embeddings stored for product: ${product.title}`);
        } else {
          this.logger.warn(`⚠️ No embeddings generated for product: ${product.title}`);
        }

        // Small delay to avoid overwhelming the AI server
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (error) {
        this.logger.error(`Failed to process product ${product.id}:`, error);
        // Continue with next product instead of failing the entire batch
      }
    }

    this.logger.log('Product embeddings backfill completed');
  }
} 