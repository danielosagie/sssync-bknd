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
      .from('ProductVariants')
      .select(`
        Id, ProductId, Title, Description, UserId,
        ProductImages!inner(ImageUrl)
      `)
      .not('Id', 'in', 
        `(SELECT "ProductVariantId" FROM "ProductEmbeddings" WHERE "ProductVariantId" IS NOT NULL)`
      )
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
        // Generate embeddings
        this.logger.log(`Generating embeddings for product: ${product.Title}`);
        
        let imageEmbedding: number[] | null = null;
        let textEmbedding: number[] | null = null;
        let combinedEmbedding: number[] | null = null;

        const imageUrl = product.ProductImages?.[0]?.ImageUrl;

        // Generate image embedding if image URL exists
        if (imageUrl) {
          try {
            imageEmbedding = await this.embeddingService.generateImageEmbedding({
              imageUrl: imageUrl
            });
          } catch (error) {
            this.logger.warn(`Failed to generate image embedding for product ${product.Id}:`, error.message);
          }
        }

        // Generate text embedding
        const textContent = [product.Title, product.Description].filter(Boolean).join(' ');
        if (textContent) {
          try {
            textEmbedding = await this.embeddingService.generateTextEmbedding({
              title: product.Title,
              description: product.Description
            });
          } catch (error) {
            this.logger.warn(`Failed to generate text embedding for product ${product.Id}:`, error.message);
          }
        }

        // Generate combined embedding if both exist
        if (imageEmbedding && textEmbedding) {
          try {
            // Use the existing embeddings to create a combined one
            // This is more efficient than regenerating from scratch
            const combined = imageEmbedding.map((imgVal, i) => 
              imgVal * 0.7 + textEmbedding[i] * 0.3
            );
            combinedEmbedding = combined;
          } catch (error) {
            this.logger.warn(`Failed to generate combined embedding for product ${product.Id}:`, error.message);
          }
        }

        // Store embeddings if at least one was generated
        if (imageEmbedding || textEmbedding || combinedEmbedding) {
          await this.embeddingService.storeProductEmbedding({
            productId: product.ProductId,
            ProductVariantId: product.Id,
            imageEmbedding: imageEmbedding || undefined,
            textEmbedding: textEmbedding || undefined,
            combinedEmbedding: combinedEmbedding || undefined,
            imageUrl: imageUrl,
            productText: textContent,
            sourceType: 'backfill',
            businessTemplate: 'General Products' // Use default template
          });

          this.logger.log(`✅ Embeddings stored for product: ${product.Title}`);
        } else {
          this.logger.warn(`⚠️ No embeddings generated for product: ${product.Title}`);
        }

        // Small delay to avoid overwhelming the AI server
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (error) {
        this.logger.error(`Failed to process product ${product.Id}:`, error);
        // Continue with next product instead of failing the entire batch
      }
    }

    this.logger.log('Product embeddings backfill completed');
  }
} 