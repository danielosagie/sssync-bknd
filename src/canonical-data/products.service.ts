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

    async saveProduct(product: Omit<Product, 'Id' | 'CreatedAt' | 'UpdatedAt'>): Promise<Product> {
        const supabase = this.getSupabaseClient();
        this.logger.log(`Saving product for user ${product.UserId}`);

        const { data, error } = await supabase
            .from('Products')
            .insert(product)
            .select()
            .single();

        if (error || !data) {
            this.logger.error(`Failed to save product for user ${product.UserId}: ${error?.message}`, error);
            throw new InternalServerErrorException(`Could not save product: ${error?.message}`);
        }
        this.logger.log(`Product saved with ID: ${data.Id}`);
        return data as Product;
    }

    async saveVariants(variants: Array<Omit<ProductVariant, 'Id' | 'CreatedAt' | 'UpdatedAt'>>): Promise<ProductVariant[]> {
        if (!variants || variants.length === 0) {
            this.logger.log('No variants to save.');
            return [];
        }
        const supabase = this.getSupabaseClient();
        const firstVariant = variants[0];
        this.logger.log(`Saving ${variants.length} variants for user ${firstVariant.UserId}, product ${firstVariant.ProductId}`);

        // Ensure all variants have ProductId and UserId
        for (const variant of variants) {
            if (!variant.ProductId || !variant.UserId) {
                throw new InternalServerErrorException('Variant is missing ProductId or UserId for saving.');
            }
        }
        
        const { data, error } = await supabase
            .from('ProductVariants')
            .upsert(variants, { 
                onConflict: 'UserId, Sku', // Assumes Sku should be unique per user for a product
                ignoreDuplicates: false, // Update existing if Sku matches for user
            })
            .select();

        if (error) {
            this.logger.error(`Failed to save variants for user ${firstVariant.UserId}, product ${firstVariant.ProductId}: ${error?.message}`, error);
            throw new InternalServerErrorException(`Could not save variants: ${error?.message}`);
        }
        this.logger.log(`Successfully saved/updated ${data?.length || 0} variants.`);
        return (data || []) as ProductVariant[];
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