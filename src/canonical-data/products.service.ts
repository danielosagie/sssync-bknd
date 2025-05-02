import { Injectable, Logger, NotFoundException, InternalServerErrorException } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service'; // Adjust path
import { Product } from './entities/product.entity';
import { ProductVariant } from './entities/product-variant.entity';
import { SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class ProductsService {
    private readonly logger = new Logger(ProductsService.name);

    constructor(private supabaseService: SupabaseService) {}

    private getSupabaseClient(): SupabaseClient {
        return this.supabaseService.getClient();
    }

    /**
     * Fetches minimal variant details (Id, Sku, Barcode, Title) for a user.
     * Used for initial scan mapping suggestions.
     */
    async findVariantsByUserId(userId: string): Promise<Partial<ProductVariant>[]> {
        const supabase = this.getSupabaseClient();
        this.logger.debug(`Fetching all variants for user ${userId}`);
        const { data, error } = await supabase
            .from('ProductVariants')
            .select('Id, Sku, Barcode, Title') // Select fields needed for matching
            .eq('UserId', userId);

        if (error) {
            this.logger.error(`Error fetching variants for user ${userId}: ${error.message}`);
            throw new InternalServerErrorException(`Could not fetch variants: ${error.message}`);
        }
        return (data || []) as Partial<ProductVariant>[];
    }

    /**
     * Creates a new Product and a corresponding ProductVariant in the database.
     * NOTE: Ideally, this should be wrapped in a database transaction.
     */
    async createProductWithVariant(userId: string, variantData: Omit<ProductVariant, 'Id' | 'ProductId' | 'UserId' | 'CreatedAt' | 'UpdatedAt'>): Promise<ProductVariant> {
        const supabase = this.getSupabaseClient();
        this.logger.log(`Creating new product and variant for user ${userId}, SKU: ${variantData.Sku}`);

        // 1. Create Product entry
        const { data: productData, error: productError } = await supabase
            .from('Products')
            .insert({ UserId: userId, IsArchived: false })
            .select('Id')
            .single();

        if (productError || !productData) {
            this.logger.error(`Failed to create product entry for user ${userId}: ${productError?.message}`, productError);
            throw new InternalServerErrorException(`Could not create product entry: ${productError?.message}`);
        }
        const newProductId = productData.Id;
        this.logger.log(`Created new product with ID: ${newProductId}`);

        // 2. Create ProductVariant entry linking to new ProductId
        const fullVariantData = {
            ...variantData,
            ProductId: newProductId,
            UserId: userId,
            // Ensure required fields are present
            Sku: variantData.Sku, // Assuming Sku is always required
            Title: variantData.Title || 'Untitled', // Provide defaults if necessary
            Price: variantData.Price ?? 0,
        };

        const { data: newVariantData, error: variantError } = await supabase
            .from('ProductVariants')
            .insert(fullVariantData)
            .select()
            .single();

        if (variantError || !newVariantData) {
            this.logger.error(`Failed to create product variant for product ${newProductId}, SKU ${variantData.Sku}: ${variantError?.message}`, variantError);
            // CRITICAL: Consider rolling back the Product creation or marking it for cleanup
            this.logger.warn(`Product ${newProductId} was created, but variant creation failed. Recommend implementing transactions.`);
            throw new InternalServerErrorException(`Could not create product variant: ${variantError?.message}`);
        }

        this.logger.log(`Successfully created variant ${newVariantData.Id} for product ${newProductId}`);
        return newVariantData as ProductVariant;
    }

    // Add other methods as needed (getProductById, updateVariant, etc.)

} 