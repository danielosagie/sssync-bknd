// src/products/products.controller.ts
import { Controller, Post, Body, Query, UsePipes, ValidationPipe, Logger, BadRequestException, HttpCode, HttpStatus, UseGuards, Request, Get, Param, NotFoundException, InternalServerErrorException, HttpException } from '@nestjs/common';
import { ProductsService, SimpleProduct, SimpleProductVariant, SimpleAiGeneratedContent } from './products.service';
import { AnalyzeImagesDto } from './dto/analyze-images.dto';
import { GenerateDetailsDto } from './dto/generate-details.dto';
import { SerpApiLensResponse } from './image-recognition/image-recognition.service';
import { GeneratedDetails } from './ai-generation/ai-generation.service';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { FeatureUsageGuard, Feature } from '../common/guards/feature-usage.guard';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { PublishProductDto } from './dto/publish-product.dto';
import { ProductVariant } from '../common/types/supabase.types';
import { ShopifyProductSetInput, ShopifyProductFile, ShopifyLocationNode, ShopifyInventoryLevelNode } from '../platform-adapters/shopify/shopify-api-client.service';
import { PlatformConnectionsService } from '../platform-connections/platform-connections.service';
import { ShopifyApiClient } from '../platform-adapters/shopify/shopify-api-client.service';
import { PlatformProductMappingsService } from '../platform-product-mappings/platform-product-mappings.service';
import { SupabaseService } from '../common/supabase.service';
import * as QueueManager from '../queue-manager';

interface LocationProduct {
    variantId: string;
    sku: string;
    title: string;
    quantity: number;
    updatedAt: string;
    productId: string;
    platformVariantId: string;
    platformProductId: string;
}

interface LocationWithProducts {
    id: string;
    name: string;
    isActive: boolean;
    products: LocationProduct[];
}

@Controller('products')
@UseGuards(SupabaseAuthGuard, ThrottlerGuard, FeatureUsageGuard)
export class ProductsController {
    private readonly logger = new Logger(ProductsController.name);
    private readonly MAX_RETRIES = 2;
    private readonly RETRY_DELAY = 1000; // 1 second delay between retries

    constructor(
        private readonly productsService: ProductsService,
        private readonly platformConnectionsService: PlatformConnectionsService,
        private readonly shopifyApiClient: ShopifyApiClient,
        private readonly platformProductMappingsService: PlatformProductMappingsService,
        private readonly supabaseService: SupabaseService
    ) {}

    // Helper method for retry logic
    private async withRetry<T>(operation: () => Promise<T>, operationName: string): Promise<T> {
        let lastError: any;
        for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error;
                if (attempt < this.MAX_RETRIES) {
                    this.logger.warn(`${operationName} attempt ${attempt} failed, retrying in ${this.RETRY_DELAY}ms...`);
                    await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY));
                }
            }
        }
        throw lastError;
    }

    /**
     * Endpoint 1 (Revised): Analyzes images, creates draft, saves analysis.
     */
    @Post('analyze')
    @Feature('aiScans')
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard)
    @Throttle({ default: { limit: 5, ttl: 60000 }}) // 5 requests per minute
    @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    @HttpCode(HttpStatus.OK)
    async analyzeAndCreateDraft(
        @Request() req,
        @Body() analyzeImagesDto: AnalyzeImagesDto,
    ): Promise<{ product: SimpleProduct; variant: SimpleProductVariant; analysis?: SimpleAiGeneratedContent }> {
        return this.withRetry(
            async () => {
                const userId = (req.user as any)?.id;
                if (!userId) {
                    throw new BadRequestException('User ID not found after authentication.');
                }

                this.logger.log(`Analyze images request for user: ${userId}`);
                if (!analyzeImagesDto || !analyzeImagesDto.imageUris || analyzeImagesDto.imageUris.length === 0) {
                    throw new BadRequestException('At least one image URI is required in the request body.');
                }

                const primaryImageUrl = analyzeImagesDto.imageUris[0];
                const initialData = {};

                return this.productsService.analyzeAndCreateDraft(
                    userId,
                    primaryImageUrl,
                    initialData,
                );
            },
            'analyzeAndCreateDraft'
        );
    }

    /**
     * Endpoint 2 (Revised): Generates AI details for an existing draft product/variant.
     */
    @Post('generate-details')
    @Feature('aiScans')
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard)
    @Throttle({ default: { limit: 5, ttl: 60000 }}) // 5 requests per minute
    @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    async generateDetailsForDraft(
        @Request() req,
        @Body() generateDetailsDto: GenerateDetailsDto,
    ): Promise<{ generatedDetails: GeneratedDetails | null }> {
        return this.withRetry(
            async () => {
                const userId = (req.user as any)?.id;
                if (!userId) {
                    throw new BadRequestException('User ID not found after authentication.');
                }
                if (!generateDetailsDto.productId || !generateDetailsDto.variantId) {
                    throw new BadRequestException('productId and variantId are required in the request body.');
                }
                if (generateDetailsDto.coverImageIndex >= generateDetailsDto.imageUris.length) {
                    throw new BadRequestException('coverImageIndex is out of bounds for the provided imageUris array.');
                }

                return this.productsService.generateDetailsForDraft(
                    userId,
                    generateDetailsDto.productId,
                    generateDetailsDto.variantId,
                    generateDetailsDto.imageUris,
                    generateDetailsDto.coverImageIndex,
                    generateDetailsDto.selectedPlatforms,
                    generateDetailsDto.selectedMatch,
                );
            },
            'generateDetailsForDraft'
        );
    }

    @Post('publish')
    @UseGuards(SupabaseAuthGuard)
    @HttpCode(HttpStatus.ACCEPTED)
    async saveOrPublishProduct(
        @Request() req,
        @Body(ValidationPipe) publishProductDto: PublishProductDto,
    ): Promise<{ message: string; /* Add results if needed */ }> {
        const userId = req.user.id;
        this.logger.log(`Received ${publishProductDto.publishIntent} request for variant ${publishProductDto.variantId} from user ${userId}`);

        await this.productsService.saveOrPublishListing(userId, publishProductDto);

        return { message: `${publishProductDto.publishIntent} request received and processing started.` };
    }

    @Post()
    async createProduct(
        @Body() data: { userId: string; variantData: Omit<ProductVariant, 'Id' | 'ProductId' | 'UserId' | 'CreatedAt' | 'UpdatedAt'> }
    ): Promise<{ product: SimpleProduct; variant: SimpleProductVariant; analysis?: SimpleAiGeneratedContent }> {
        return this.productsService.createProductWithVariant(data.userId, data.variantData);
    }

    @Post(':id/publish/shopify')
    @UseGuards(SupabaseAuthGuard)
    @Feature('shopify')
    async publishToShopify(
        @Param('id') productId: string,
        @Body() publishData: {
            platformConnectionId: string;
            locations: Array<{ locationId: string; quantity: number }>;
            options?: {
                status?: 'ACTIVE' | 'DRAFT' | 'ARCHIVED';
                vendor?: string;
                productType?: string;
                tags?: string[];
            };
        },
        @Request() req: any
    ) {
        const userId = req.user.id;
        const { platformConnectionId, locations, options } = publishData;

        try {
            // Get the product and its variants
            const { product, variants } = await this.productsService.getProduct(productId, userId);
            if (!product) {
                throw new NotFoundException(`Product ${productId} not found`);
            }

            // Get the platform connection
            const connection = await this.platformConnectionsService.getConnectionById(platformConnectionId, userId);
            if (!connection || connection.PlatformType !== 'shopify') {
                throw new BadRequestException('Invalid Shopify platform connection');
            }

            // Get available locations from Shopify
            const shopifyLocations = await this.shopifyApiClient.getAllLocations(connection);
            const validLocationIds = new Set(shopifyLocations.map(loc => loc.id));

            // Validate location IDs
            const invalidLocations = locations.filter(loc => !validLocationIds.has(loc.locationId));
            if (invalidLocations.length > 0) {
                throw new BadRequestException(
                    `Invalid location IDs: ${invalidLocations.map(loc => loc.locationId).join(', ')}`
                );
            }

            // Get product images for variants
            const supabase = this.supabaseService.getClient();
            const { data: variantImages, error: imagesError } = await supabase
                .from('ProductImages')
                .select('ProductVariantId, ImageUrl, AltText')
                .in('ProductVariantId', variants.map(v => v.Id));

            if (imagesError) {
                this.logger.error(`Failed to fetch variant images: ${imagesError.message}`);
                throw new InternalServerErrorException('Failed to fetch variant images');
            }

            // Create a map of variant ID to image URL
            const variantImageMap = new Map(
                variantImages?.map(img => [img.ProductVariantId, img.ImageUrl]) || []
            );

            // Prepare product input for Shopify
            const productInput: ShopifyProductSetInput = {
                title: product.Title,
                descriptionHtml: product.Description || undefined,
                status: options?.status || 'ACTIVE',
                vendor: options?.vendor,
                productType: options?.productType,
                tags: options?.tags,
                productOptions: variants[0]?.Options ? [
                    {
                        name: 'Option',
                        values: variants.map(v => ({ name: v.Title }))
                    }
                ] : undefined,
                variants: variants.map(variant => {
                    const imageUrl = variantImageMap.get(variant.Id);
                    const file: ShopifyProductFile | undefined = imageUrl ? {
                        originalSource: imageUrl,
                        alt: `${product.Title} - ${variant.Title}`,
                        filename: `${variant.Sku}.jpg`,
                        contentType: 'IMAGE'
                    } : undefined;

                    return {
                        optionValues: variant.Options ? [
                            {
                                optionName: 'Option',
                                name: variant.Title
                            }
                        ] : [],
                        price: variant.Price.toString(),
                        sku: variant.Sku,
                        inventoryItem: {
                            tracked: true,
                            measurement: variant.Weight ? {
                                weight: {
                                    value: variant.Weight,
                                    unit: 'POUNDS'
                                }
                            } : undefined
                        },
                        inventoryQuantities: locations.map(loc => ({
                            locationId: loc.locationId,
                            name: 'available',
                            quantity: loc.quantity
                        })),
                        taxable: true,
                        barcode: variant.Barcode || undefined,
                        file
                    };
                })
            };

            // Create the product in Shopify
            const result = await this.shopifyApiClient.createProductAsync(connection, productInput);

            // Create platform mapping
            if (result.productId && variants.length > 0) {
                await this.platformProductMappingsService.createMapping({
                    PlatformConnectionId: platformConnectionId,
                    ProductVariantId: variants[0].Id, // Map the first variant
                    PlatformProductId: result.productId,
                    PlatformVariantId: result.productId, // For now, using the same ID
                    PlatformSku: variants[0].Sku,
                    PlatformSpecificData: {
                        operationId: result.operationId,
                        status: result.status
                    }
                });
            }

            return { success: true, productId: result.productId, operationId: result.operationId };
        } catch (error) {
            this.logger.error(`Failed to publish product to Shopify: ${error.message}`, error.stack);
            if (error instanceof HttpException) {
                throw error;
            }
            throw new InternalServerErrorException('Failed to publish product to Shopify');
        }
    }

    @Get('shopify/locations')
    @UseGuards(SupabaseAuthGuard)
    @Feature('shopify')
    @Throttle({ default: { limit: 10, ttl: 60000 }}) // 10 requests per minute
    async getShopifyLocations(
        @Query('platformConnectionId') platformConnectionId: string,
        @Request() req: any
    ): Promise<{ locations: ShopifyLocationNode[] }> {
        return this.withRetry(
            async () => {
                const userId = req.user.id;

                // Get the platform connection
                const connection = await this.platformConnectionsService.getConnectionById(platformConnectionId, userId);
                if (!connection || connection.PlatformType !== 'shopify') {
                    throw new BadRequestException('Invalid Shopify platform connection');
                }

                // Get locations from Shopify
                const locations = await this.shopifyApiClient.getAllLocations(connection);
                return { locations };
            },
            'getShopifyLocations'
        );
    }

    @Get('shopify/inventory')
    @UseGuards(SupabaseAuthGuard)
    @Feature('shopify')
    @Throttle({ default: { limit: 10, ttl: 60000 }}) // 10 requests per minute
    async getShopifyInventory(
        @Query('platformConnectionId') platformConnectionId: string,
        @Query('sync') sync: boolean = false,
        @Request() req: any
    ): Promise<{
        inventory: Array<{
            variantId: string;
            sku: string;
            title: string;
            locations: Array<{
                locationId: string;
                locationName: string;
                quantity: number;
                updatedAt: string;
            }>;
            productId: string;
            platformVariantId: string;
            platformProductId: string;
        }>;
        lastSyncedAt: string | null;
    }> {
        return this.withRetry(
            async () => {
                const userId = req.user.id;

                // Get the platform connection
                const connection = await this.platformConnectionsService.getConnectionById(platformConnectionId, userId);
                if (!connection || connection.PlatformType !== 'shopify') {
                    throw new BadRequestException('Invalid Shopify platform connection');
                }

                const supabase = this.supabaseService.getClient();

                // If sync is requested, fetch latest data from Shopify
                if (sync) {
                    // Get all product mappings for this connection
                    const { data: mappings, error: mappingsError } = await supabase
                        .from('PlatformProductMappings')
                        .select(`
                            Id,
                            ProductVariantId,
                            PlatformProductId,
                            PlatformVariantId,
                            ProductVariants (
                                Id,
                                Sku,
                                Title
                            )
                        `)
                        .eq('PlatformConnectionId', platformConnectionId)
                        .eq('IsEnabled', true);

                    if (mappingsError) {
                        throw new InternalServerErrorException('Failed to fetch product mappings');
                    }

                    // Fetch inventory levels from Shopify for all variants
                    const inventoryLevels = await this.shopifyApiClient.getInventoryLevels(
                        connection,
                        mappings.map(m => m.PlatformVariantId).filter(Boolean)
                    );

                    // Update inventory levels in our database
                    for (const level of inventoryLevels) {
                        const mapping = mappings.find(m => m.PlatformVariantId === level.variantId);
                        if (!mapping) continue;

                        const { error: upsertError } = await supabase
                            .from('InventoryLevels')
                            .upsert({
                                ProductVariantId: mapping.ProductVariantId,
                                PlatformConnectionId: platformConnectionId,
                                PlatformLocationId: level.locationId,
                                Quantity: level.quantity,
                                UpdatedAt: new Date().toISOString()
                            }, {
                                onConflict: 'ProductVariantId,PlatformConnectionId,PlatformLocationId'
                            });

                        if (upsertError) {
                            this.logger.error(`Failed to update inventory level: ${upsertError.message}`);
                        }
                    }

                    // Update last sync timestamp
                    await supabase
                        .from('PlatformConnections')
                        .update({ LastSyncSuccessAt: new Date().toISOString() })
                        .eq('Id', platformConnectionId);
                }

                // Fetch current inventory levels from our database
                const { data: inventory, error: inventoryError } = await supabase
                    .from('InventoryLevels')
                    .select(`
                        ProductVariantId,
                        PlatformLocationId,
                        Quantity,
                        UpdatedAt,
                        ProductVariants (
                            Id,
                            Sku,
                            Title
                        ),
                        PlatformProductMappings (
                            PlatformProductId,
                            PlatformVariantId
                        )
                    `)
                    .eq('PlatformConnectionId', platformConnectionId);

                if (inventoryError) {
                    throw new InternalServerErrorException('Failed to fetch inventory levels');
                }

                // Get location names from Shopify
                const locations = await this.shopifyApiClient.getAllLocations(connection);
                const locationMap = new Map(locations.map(loc => [loc.id, loc]));

                // Group inventory by variant
                const inventoryByVariant = new Map();
                for (const item of inventory) {
                    if (!inventoryByVariant.has(item.ProductVariantId)) {
                        const variant = item.ProductVariants[0]; // Get first item since it's a single variant
                        const mapping = item.PlatformProductMappings[0]; // Get first item since it's a single mapping
                        inventoryByVariant.set(item.ProductVariantId, {
                            variantId: item.ProductVariantId,
                            sku: variant.Sku,
                            title: variant.Title,
                            locations: [],
                            productId: mapping?.PlatformProductId,
                            platformVariantId: mapping?.PlatformVariantId,
                            platformProductId: mapping?.PlatformProductId
                        });
                    }

                    const location = locationMap.get(item.PlatformLocationId);
                    if (location) {
                        inventoryByVariant.get(item.ProductVariantId).locations.push({
                            locationId: item.PlatformLocationId,
                            locationName: location.name,
                            quantity: item.Quantity,
                            updatedAt: item.UpdatedAt
                        });
                    }
                }

                // Get last sync timestamp
                const { data: connectionData } = await supabase
                    .from('PlatformConnections')
                    .select('LastSyncSuccessAt')
                    .eq('Id', platformConnectionId)
                    .single();

                return {
                    inventory: Array.from(inventoryByVariant.values()),
                    lastSyncedAt: connectionData?.LastSyncSuccessAt || null
                };
            },
            'getShopifyInventory'
        );
    }

    @Get('shopify/locations-with-products')
    @UseGuards(SupabaseAuthGuard)
    @Feature('shopify')
    @Throttle({ default: { limit: 10, ttl: 60000 }}) // 10 requests per minute
    async getShopifyLocationsWithProducts(
        @Query('platformConnectionId') platformConnectionId: string,
        @Query('sync') sync: boolean = false,
        @Request() req: any
    ): Promise<{
        locations: Array<{
            id: string;
            name: string;
            isActive: boolean;
            products: Array<{
                variantId: string;
                sku: string;
                title: string;
                quantity: number;
                updatedAt: string;
                productId: string;
                platformVariantId: string;
                platformProductId: string;
            }>;
        }>;
        lastSyncedAt: string | null;
    }> {
        return this.withRetry(
            async () => {
                const userId = req.user.id;

                // Get the platform connection
                const connection = await this.platformConnectionsService.getConnectionById(platformConnectionId, userId);
                if (!connection || connection.PlatformType !== 'shopify') {
                    throw new BadRequestException('Invalid Shopify platform connection');
                }

                const supabase = this.supabaseService.getClient();

                // Get all locations from Shopify
                const locations = await this.shopifyApiClient.getAllLocations(connection);
                const locationMap = new Map<string, LocationWithProducts>();

                // If sync is requested, fetch latest data from Shopify
                if (sync) {
                    // Get all product mappings for this connection
                    const { data: mappings, error: mappingsError } = await supabase
                        .from('PlatformProductMappings')
                        .select(`
                            Id,
                            ProductVariantId,
                            PlatformProductId,
                            PlatformVariantId,
                            ProductVariants (
                                Id,
                                Sku,
                                Title
                            )
                        `)
                        .eq('PlatformConnectionId', platformConnectionId)
                        .eq('IsEnabled', true);

                    if (mappingsError) {
                        throw new InternalServerErrorException('Failed to fetch product mappings');
                    }

                    // Fetch inventory levels from Shopify for all variants
                    const inventoryLevels = await this.shopifyApiClient.getInventoryLevels(
                        connection,
                        mappings.map(m => m.PlatformVariantId).filter(Boolean)
                    );

                    // Update inventory levels in our database
                    for (const level of inventoryLevels) {
                        const mapping = mappings.find(m => m.PlatformVariantId === level.variantId);
                        if (!mapping) continue;

                        const { error: upsertError } = await supabase
                            .from('InventoryLevels')
                            .upsert({
                                ProductVariantId: mapping.ProductVariantId,
                                PlatformConnectionId: platformConnectionId,
                                PlatformLocationId: level.locationId,
                                Quantity: level.quantity,
                                UpdatedAt: new Date().toISOString()
                            }, {
                                onConflict: 'ProductVariantId,PlatformConnectionId,PlatformLocationId'
                            });

                        if (upsertError) {
                            this.logger.error(`Failed to update inventory level: ${upsertError.message}`);
                        }
                    }

                    // Update last sync timestamp
                    await supabase
                        .from('PlatformConnections')
                        .update({ LastSyncSuccessAt: new Date().toISOString() })
                        .eq('Id', platformConnectionId);
                }

                // Fetch current inventory levels from our database
                const { data: inventory, error: inventoryError } = await supabase
                    .from('InventoryLevels')
                    .select(`
                        ProductVariantId,
                        PlatformLocationId,
                        Quantity,
                        UpdatedAt,
                        ProductVariants (
                            Id,
                            Sku,
                            Title
                        ),
                        PlatformProductMappings (
                            PlatformProductId,
                            PlatformVariantId
                        )
                    `)
                    .eq('PlatformConnectionId', platformConnectionId);

                if (inventoryError) {
                    throw new InternalServerErrorException('Failed to fetch inventory levels');
                }

                // Group inventory by location
                for (const item of inventory) {
                    const location = locationMap.get(item.PlatformLocationId);
                    if (location) {
                        const variant = item.ProductVariants[0];
                        const mapping = item.PlatformProductMappings[0];
                        if (mapping?.PlatformProductId && mapping?.PlatformVariantId) {
                            location.products.push({
                                variantId: item.ProductVariantId,
                                sku: variant.Sku,
                                title: variant.Title,
                                quantity: item.Quantity,
                                updatedAt: item.UpdatedAt,
                                productId: mapping.PlatformProductId,
                                platformVariantId: mapping.PlatformVariantId,
                                platformProductId: mapping.PlatformProductId
                            });
                        }
                    }
                }

                // Get last sync timestamp
                const { data: connectionData } = await supabase
                    .from('PlatformConnections')
                    .select('LastSyncSuccessAt')
                    .eq('Id', platformConnectionId)
                    .single();

                return {
                    locations: Array.from(locationMap.values()),
                    lastSyncedAt: connectionData?.LastSyncSuccessAt || null
                };
            },
            'getShopifyLocationsWithProducts'
        );
    }

    /**
     * Example endpoint: Queue a product sync job (demonstrates dynamic queue usage)
     */
    @Post('queue-sync')
    async queueProductSync(@Request() req, @Body('productId') productId: string) {
        const userId = req.user.id;
        await QueueManager.enqueueJob({ type: 'product-sync', productId, userId, timestamp: Date.now() });
        return { success: true, message: 'Product sync job queued.' };
    }

    // ... (TODO endpoints) ...
}