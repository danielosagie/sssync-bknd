// src/products/products.controller.ts
import { Controller, Post, Body, Query, UsePipes, ValidationPipe, Logger, BadRequestException, HttpCode, HttpStatus, UseGuards, Request, Get, Param, NotFoundException, InternalServerErrorException, HttpException, Req } from '@nestjs/common';
import { ProductsService, SimpleProduct, SimpleProductVariant, SimpleAiGeneratedContent, GeneratedDetails } from './products.service';
import { AnalyzeImagesDto } from './dto/analyze-images.dto';
import { GenerateDetailsDto } from './dto/generate-details.dto';
import { SerpApiLensResponse } from './image-recognition/image-recognition.service';
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
import { Request as ExpressRequest } from 'express';
import { User } from '@supabase/supabase-js';
import { SubscriptionLimitGuard } from '../common/subscription-limit.guard';
import { SkuCheckDto } from './dto/sku-check.dto';

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

// Define AuthenticatedRequest interface here
export interface AuthenticatedRequest extends ExpressRequest {
  user: User & { id: string; aud: string; role: string; email: string };
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
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard, SubscriptionLimitGuard)
    @Throttle({ default: { limit: 5, ttl: 60000 }}) // 5 requests per minute
    @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    @HttpCode(HttpStatus.OK)
    async analyzeProduct(
        @Body() analyzeImagesDto: AnalyzeImagesDto,
        @Req() req: AuthenticatedRequest,
    ): Promise<{ product: SimpleProduct; variant: SimpleProductVariant; analysis?: SimpleAiGeneratedContent }> {
        return this.withRetry(
            async () => {
                const userId = req.user?.id;
                if (!userId) {
                    throw new BadRequestException('User ID not found after authentication.');
                }

                this.logger.log(`[POST /analyze] User: ${userId} - Analyzing image(s)`);
                if (!analyzeImagesDto || !analyzeImagesDto.imageUris || analyzeImagesDto.imageUris.length === 0) {
                    throw new BadRequestException('At least one image URI is required in the request body.');
                }
                const primaryImageUrl = analyzeImagesDto.imageUris[0];

                const result = await this.productsService.analyzeAndCreateDraft(userId, primaryImageUrl);
                this.logger.log(`[POST /analyze] User: ${userId} - Analysis complete. ProductID: ${result.product.Id}`);
                return result;
            },
            'analyzeProduct'
        );
    }

    /**
     * Endpoint 2 (Revised): Generates AI details for an existing draft product/variant.
     */
    @Post('generate-details')
    @Feature('aiScans')
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard, SubscriptionLimitGuard)
    @Throttle({ default: { limit: 5, ttl: 60000 }}) // 5 requests per minute
    @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    async generateDetails(
        @Body() generateDetailsDto: GenerateDetailsDto,
        @Req() req: AuthenticatedRequest,
    ): Promise<{ generatedDetails: GeneratedDetails | null }> {
        return this.withRetry(
            async () => {
                const userId = req.user?.id;
                if (!userId) {
                    throw new BadRequestException('User ID not found after authentication.');
                }
                this.logger.log(`[POST /generate-details] User: ${userId} - Generating details for variant ${generateDetailsDto.variantId}`);
                if (!generateDetailsDto.productId || !generateDetailsDto.variantId) {
                    throw new BadRequestException('productId and variantId are required in the request body.');
                }
                if (generateDetailsDto.imageUris.length === 0 || generateDetailsDto.coverImageIndex >= generateDetailsDto.imageUris.length) {
                    throw new BadRequestException('imageUris must not be empty and coverImageIndex must be valid.');
                }

                const result = await this.productsService.generateDetailsForDraft(
                    userId,
                    generateDetailsDto.productId,
                    generateDetailsDto.variantId,
                    generateDetailsDto.imageUris,
                    generateDetailsDto.coverImageIndex,
                    generateDetailsDto.selectedPlatforms,
                    generateDetailsDto.selectedMatch,
                );
                this.logger.log(`[POST /generate-details] User: ${userId} - Details generated for variant ${generateDetailsDto.variantId}`);
                return result;
            },
            'generateDetails'
        );
    }

    @Post('publish')
    @UseGuards(SupabaseAuthGuard)
    @HttpCode(HttpStatus.ACCEPTED)
    @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    async saveOrPublishProduct(
        @Body() publishProductDto: PublishProductDto,
        @Req() req: AuthenticatedRequest,
    ): Promise<{ message: string }> {
        const userId = req.user.id;
        this.logger.log(`[POST /publish] User: ${userId} - Received ${publishProductDto.publishIntent} request for variant ${publishProductDto.variantId}`);
        await this.productsService.saveOrPublishListing(userId, publishProductDto);
        this.logger.log(`[POST /publish] User: ${userId} - ${publishProductDto.publishIntent} processed for variant ${publishProductDto.variantId}`);
        return { message: `${publishProductDto.publishIntent} request received and processing started.` };
    }

    @Post()
    @UseGuards(SupabaseAuthGuard)
    async createProduct(
        @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })) 
        data: { userId: string; variantData: Omit<ProductVariant, 'Id' | 'ProductId' | 'UserId' | 'CreatedAt' | 'UpdatedAt'> },
        @Req() req: AuthenticatedRequest
    ): Promise<{ product: SimpleProduct; variant: SimpleProductVariant; analysis?: SimpleAiGeneratedContent }> {
        const authUserId = req.user.id;
        if (authUserId !== data.userId) {
            this.logger.warn(`User ID in token (${authUserId}) does not match User ID in body (${data.userId}). Using token ID.`);
        }
        return this.productsService.createProductWithVariant(authUserId, data.variantData);
    }

    @Post(':id/publish/shopify')
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard)
    @Feature('shopify')
    async publishToShopify(
        @Param('id') productId: string,
        @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })) 
        publishData: {
            platformConnectionId: string;
            locations: Array<{ locationId: string; quantity: number }>;
            options?: {
                status?: 'ACTIVE' | 'DRAFT' | 'ARCHIVED';
                vendor?: string;
                productType?: string;
                tags?: string[];
            };
        },
        @Req() req: AuthenticatedRequest
    ) {
        this.logger.log(`[publishToShopify] Entered method for productId: ${productId}, user: ${req.user.id}`);
        this.logger.debug(`[publishToShopify] Received publishData: ${JSON.stringify(publishData, null, 2)}`);

        const userId = req.user.id;
        const { platformConnectionId, locations, options } = publishData;

        try {
            this.logger.log(`[publishToShopify] Inside try block for productId: ${productId}`);
            const { product, variants } = await this.productsService.getProduct(productId, userId);
            if (!product) {
                throw new NotFoundException(`Product ${productId} not found`);
            }
            this.logger.log(`[publishToShopify] Fetched product: ${JSON.stringify(product)}`);
            this.logger.log(`[publishToShopify] Fetched variants: ${JSON.stringify(variants)}`);

            if (!variants || variants.length === 0) {
                this.logger.error(`[publishToShopify] No variants found for product ${productId}. Cannot publish to Shopify.`);
                throw new InternalServerErrorException('No product variants found to publish.');
            }

            const primaryVariant = variants[0];

            const connection = await this.platformConnectionsService.getConnectionById(platformConnectionId, userId);
            if (!connection || connection.PlatformType !== 'shopify') {
                throw new BadRequestException('Invalid Shopify platform connection');
            }

            const shopifyLocations = await this.shopifyApiClient.getAllLocations(connection);
            const validLocationIds = new Set(shopifyLocations.map(loc => loc.id));

            const invalidLocations = locations.filter(loc => !validLocationIds.has(loc.locationId));
            if (invalidLocations.length > 0) {
                throw new BadRequestException(
                    `Invalid location IDs: ${invalidLocations.map(loc => loc.locationId).join(', ')}`
                );
            }

            const supabase = this.supabaseService.getClient();
            const { data: variantImages, error: imagesError } = await supabase
                .from('ProductImages')
                .select('ProductVariantId, ImageUrl, AltText')
                .in('ProductVariantId', variants.map(v => v.Id));
                this.logger.log(`[publishToShopify] Fetched variant images: ${JSON.stringify(variantImages, null, 2)}`);

            if (imagesError) {
                this.logger.error(`Failed to fetch variant images: ${imagesError.message}`);
                throw new InternalServerErrorException('Failed to fetch variant images');
            }

            const variantImageMap = new Map(
                variantImages?.map(img => [img.ProductVariantId, img.ImageUrl]) || []
            );
            this.logger.log(`[publishToShopify] Variant image map: ${JSON.stringify(variantImageMap, null, 2)}`);

            // Determine productOptions for Shopify
            // If the primary variant has no defined .Options, create a default "Title" option
            // Otherwise, attempt to use the existing Options structure (this part might need more advanced mapping for complex options)
            const shopifyProductOptions = (!primaryVariant.Options || Object.keys(primaryVariant.Options).length === 0) 
                ? [{ name: "Title", values: variants.map(v => ({ name: v.Title })) }]
                : [{ name: "Option", values: variants.map(v => ({ name: v.Title })) }]; // Fallback or more complex mapping needed here if primaryVariant.Options is structured
            
            this.logger.log(`[ShopifyPublish] Determined shopifyProductOptions: ${JSON.stringify(shopifyProductOptions)}`);

            const productInput: ShopifyProductSetInput = {
                title: primaryVariant.Title,
                descriptionHtml: primaryVariant.Description || undefined,
                status: options?.status || 'ACTIVE',
                vendor: options?.vendor,
                productType: options?.productType,
                tags: options?.tags,
                productOptions: shopifyProductOptions, // Use the determined options
                variants: variants.map(variant => {
                    const imageUrlFromDb = variantImageMap.get(variant.Id);
                    let finalImageUrlForShopify: string | undefined = undefined;
                    let shopifyFilename = `${variant.Sku}.jpg`; // Default filename

                    if (typeof imageUrlFromDb === 'string' && imageUrlFromDb.trim() !== '') {
                        this.logger.log(`[ShopifyPublish ${variant.Id}] Raw ImageUrl from DB: "${imageUrlFromDb}"`);
                        let currentUrl = imageUrlFromDb.trim();
                        this.logger.log(`[ShopifyPublish ${variant.Id}] After trim: "${currentUrl}"`);

                        // Step 1: Extract from Markdown (if applicable)
                        // Regex assuming format like: ["Link Text"](URLContent)
                        const markdownMatch = currentUrl.match(/\\\["([^"]*)\"\\\]\\(([^)]*)\\)/);
                        if (markdownMatch && markdownMatch[2]) { // We want group 2 for the URL
                            currentUrl = markdownMatch[2].trim();
                            this.logger.log(`[ShopifyPublish ${variant.Id}] Extracted from specific Markdown format: "${currentUrl}"`);
                        } else {
                            this.logger.log(`[ShopifyPublish ${variant.Id}] No specific Markdown link format found or pattern mismatch for: "${currentUrl}". Will proceed with URL as is.`);
                        }

                        // Step 2: Decode URI Components (multiple passes)
                        try {
                            let decodedUrl = currentUrl;
                            for (let i = 0; i < 3 && decodedUrl.includes('%'); i++) { // Max 3 decodes
                                decodedUrl = decodeURIComponent(decodedUrl);
                            }
                            currentUrl = decodedUrl;
                            this.logger.log(`[ShopifyPublish ${variant.Id}] After decodeURIComponent: "${currentUrl}"`);
                        } catch (e) {
                            this.logger.error(`[ShopifyPublish ${variant.Id}] Error decoding URI for "${currentUrl}": ${e.message}`);
                        }

                        // Step 3: Remove leading/trailing literal double quotes
                        currentUrl = currentUrl.replace(/^"|"$/g, '');
                        this.logger.log(`[ShopifyPublish ${variant.Id}] After quote removal: "${currentUrl}"`);

                        // Step 4: Remove trailing semicolons (and any whitespace before them)
                        currentUrl = currentUrl.replace(/\\s*;+$/, '');
                        this.logger.log(`[ShopifyPublish ${variant.Id}] After semicolon removal: "${currentUrl}"`);

                        // Step 5: Final check if it looks like a valid HTTP/HTTPS URL
                        if (currentUrl.startsWith('http')) {
                            finalImageUrlForShopify = currentUrl;
                            this.logger.log(`[ShopifyPublish ${variant.Id}] Final clean ImageUrl for Shopify: "${finalImageUrlForShopify}"`);

                            // Attempt to derive filename from the cleaned URL
                            try {
                                const urlPath = new URL(finalImageUrlForShopify).pathname;
                                const pathSegments = urlPath.split('/');
                                const lastSegment = pathSegments.pop() || '';
                                if (lastSegment.match(/\\.(jpg|jpeg|png|webp)$/i)) {
                                    shopifyFilename = lastSegment.replace(/[^a-zA-Z0-9._-]/g, '_'); // Sanitize
                                    this.logger.log(`[ShopifyPublish ${variant.Id}] Derived filename: "${shopifyFilename}"`);
                                }
                            } catch (e) {
                                this.logger.warn(`[ShopifyPublish ${variant.Id}] Could not parse URL to derive filename: ${e.message}. Using default.`);
                            }
                        } else {
                            this.logger.warn(`[ShopifyPublish ${variant.Id}] ImageUrl for variant after cleaning ("${currentUrl}") does not appear to be a valid http/https URL. Skipping image for Shopify.`);
                        }
                    } else {
                        this.logger.warn(`[ShopifyPublish ${variant.Id}] No ImageUrl found or it is empty in DB.`);
                    }

                    const file: ShopifyProductFile | undefined = finalImageUrlForShopify ? {
                        originalSource: finalImageUrlForShopify,
                        alt: `${primaryVariant.Title} - ${variant.Title}`,
                        filename: shopifyFilename, // Use dynamic or default filename
                        contentType: 'IMAGE'
                    } : undefined;
                    
                    // Determine optionValues for this specific variant
                    const shopifyOptionValues = (!variant.Options || Object.keys(variant.Options).length === 0)
                        ? [{ optionName: "Title", name: variant.Title }]
                        : [{ optionName: "Option", name: variant.Title }]; // Fallback or more complex mapping for structured variant.Options

                    return {
                        optionValues: shopifyOptionValues, // Use determined option values
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

            this.logger.debug(`[publishToShopify] Constructed productInput for Shopify: ${JSON.stringify(productInput, null, 2)}`);

            const result = await this.shopifyApiClient.createProductAsync(connection, productInput);

            if (result.productId && variants.length > 0) {
                await this.platformProductMappingsService.createMapping({
                    PlatformConnectionId: platformConnectionId,
                    ProductVariantId: variants[0].Id, 
                    PlatformProductId: result.productId,
                    PlatformVariantId: result.productId, 
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
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard)
    @Feature('shopify')
    @Throttle({ default: { limit: 10, ttl: 60000 }})
    async getShopifyLocations(
        @Query('platformConnectionId') platformConnectionId: string,
        @Req() req: AuthenticatedRequest
    ): Promise<{ locations: ShopifyLocationNode[] }> {
        return this.withRetry(
            async () => {
                const userId = req.user.id;
                const connection = await this.platformConnectionsService.getConnectionById(platformConnectionId, userId);
                if (!connection || connection.PlatformType !== 'shopify') {
                    throw new BadRequestException('Invalid Shopify platform connection');
                }
                const locations = await this.shopifyApiClient.getAllLocations(connection);
                return { locations };
            },
            'getShopifyLocations'
        );
    }

    @Get('shopify/inventory')
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard)
    @Feature('shopify')
    @Throttle({ default: { limit: 10, ttl: 60000 }})
    async getShopifyInventory(
        @Query('platformConnectionId') platformConnectionId: string,
        @Query('sync') sync: string,
        @Req() req: AuthenticatedRequest
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
                const doSync = sync === 'true';

                const connection = await this.platformConnectionsService.getConnectionById(platformConnectionId, userId);
                if (!connection || connection.PlatformType !== 'shopify') {
                    throw new BadRequestException('Invalid Shopify platform connection');
                }

                const supabase = this.supabaseService.getClient();

                if (doSync) {
                    const { data: mappings, error: mappingsError } = await supabase
                        .from('PlatformProductMappings')
                        .select(`
                            Id,
                            ProductVariantId,
                            PlatformProductId,
                            PlatformVariantId,
                            ProductVariants!inner(
                                Id,
                                Sku,
                                Title
                            )
                        `)
                        .eq('PlatformConnectionId', platformConnectionId)
                        .eq('IsEnabled', true);

                    if (mappingsError) {
                        this.logger.error(`Mappings error: ${JSON.stringify(mappingsError)}`);
                        throw new InternalServerErrorException('Failed to fetch product mappings for sync.');
                    }
                    if(!mappings || mappings.length === 0) {
                        this.logger.warn(`No active mappings found for Shopify connection ${platformConnectionId} to sync inventory.`);
                    } else {
                        const shopifyVariantIds = mappings.map(m => m.PlatformVariantId).filter(Boolean) as string[];
                        if (shopifyVariantIds.length > 0) {
                            const inventoryLevels = await this.shopifyApiClient.getInventoryLevels(
                                connection,
                                shopifyVariantIds
                            );
                            for (const level of inventoryLevels) {
                                const mapping = mappings.find(m => m.PlatformVariantId === level.variantId);
                                if (!mapping || !mapping.ProductVariantId || !mapping.ProductVariants || mapping.ProductVariants.length === 0) continue;
        
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
                        } else {
                            this.logger.warn(`No Shopify Variant IDs found in mappings for connection ${platformConnectionId}. Skipping Shopify inventory fetch.`);
                        }
                    }
                    await supabase
                        .from('PlatformConnections')
                        .update({ LastSyncSuccessAt: new Date().toISOString() })
                        .eq('Id', platformConnectionId);
                }

                const { data: dbInventory, error: inventoryError } = await supabase
                    .from('InventoryLevels')
                    .select(`
                        ProductVariantId,
                        PlatformLocationId,
                        Quantity,
                        UpdatedAt,
                        ProductVariants!inner(
                            Id,
                            Sku,
                            Title,
                            Products!inner(Id)
                        ),
                        PlatformProductMappings!inner(
                            PlatformProductId,
                            PlatformVariantId
                        )
                    `)
                    .eq('PlatformConnectionId', platformConnectionId)
                    .eq('ProductVariants.Products.UserId', userId);
                   
                if (inventoryError) {
                    this.logger.error(`Inventory fetch error: ${JSON.stringify(inventoryError)}`);
                    throw new InternalServerErrorException('Failed to fetch inventory levels from database.');
                }

                const shopifyLocations = await this.shopifyApiClient.getAllLocations(connection);
                const locationMap = new Map(shopifyLocations.map(loc => [loc.id, loc]));

                const inventoryByVariant = new Map();
                for (const item of dbInventory) {
                    const variantInfoArray = item.ProductVariants;
                    const mappingInfoArray = item.PlatformProductMappings;

                    // Ensure related data is present and access the first element
                    const variantInfo = Array.isArray(variantInfoArray) && variantInfoArray.length > 0 ? variantInfoArray[0] : null;
                    const mappingInfo = Array.isArray(mappingInfoArray) && mappingInfoArray.length > 0 ? mappingInfoArray[0] : null;
                    const productInfo = variantInfo && Array.isArray((variantInfo as any).Products) && (variantInfo as any).Products.length > 0 ? (variantInfo as any).Products[0] : null;

                    if (!variantInfo || !mappingInfo || !productInfo) {
                        this.logger.warn(`Skipping inventory item due to missing variant, mapping, or product info: ${JSON.stringify(item)}`);
                        continue;
                    }

                    if (!inventoryByVariant.has(item.ProductVariantId)) {
                        inventoryByVariant.set(item.ProductVariantId, {
                            variantId: item.ProductVariantId,
                            sku: variantInfo.Sku,
                            title: variantInfo.Title,
                            locations: [],
                            productId: productInfo.Id, 
                            platformVariantId: mappingInfo.PlatformVariantId,
                            platformProductId: mappingInfo.PlatformProductId
                        });
                    }

                    const shopifyLocation = locationMap.get(item.PlatformLocationId);
                    if (shopifyLocation) {
                        inventoryByVariant.get(item.ProductVariantId).locations.push({
                            locationId: item.PlatformLocationId,
                            locationName: shopifyLocation.name,
                            quantity: item.Quantity,
                            updatedAt: item.UpdatedAt
                        });
                    }
                }

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
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard)
    @Feature('shopify')
    @Throttle({ default: { limit: 10, ttl: 60000 }})
    async getShopifyLocationsWithProducts(
        @Query('platformConnectionId') platformConnectionId: string,
        @Query('sync') sync: string,
        @Req() req: AuthenticatedRequest
    ): Promise<{
        locations: Array<LocationWithProducts>;
        lastSyncedAt: string | null;
    }> {
        return this.withRetry(
            async () => {
                const userId = req.user.id;
                const doSync = sync === 'true';

                const connection = await this.platformConnectionsService.getConnectionById(platformConnectionId, userId);
                if (!connection || connection.PlatformType !== 'shopify') {
                    throw new BadRequestException('Invalid Shopify platform connection');
                }

                const supabase = this.supabaseService.getClient();
                const shopifyLocationNodes = await this.shopifyApiClient.getAllLocations(connection);
                const resultLocations: LocationWithProducts[] = shopifyLocationNodes.map(sln => ({
                    id: sln.id,
                    name: sln.name,
                    isActive: sln.isActive,
                    products: []
                }));
                const locationMap = new Map(resultLocations.map(rl => [rl.id, rl]));

                if (doSync) {
                    const { data: mappings, error: mappingsError } = await supabase
                        .from('PlatformProductMappings')
                        .select(`
                            Id,
                            ProductVariantId,
                            PlatformProductId,
                            PlatformVariantId,
                            ProductVariants!inner(
                                Id,
                                Sku,
                                Title
                            )
                        `)
                        .eq('PlatformConnectionId', platformConnectionId)
                        .eq('IsEnabled', true);

                    if (mappingsError) {
                         this.logger.error(`Mappings error: ${JSON.stringify(mappingsError)}`);
                        throw new InternalServerErrorException('Failed to fetch product mappings for sync.');
                    }
                    if(!mappings || mappings.length === 0) {
                        this.logger.warn(`No active mappings found for Shopify connection ${platformConnectionId} to sync inventory locations with products.`);
                    } else {
                        const shopifyVariantIds = mappings.map(m => m.PlatformVariantId).filter(Boolean) as string[];
                        if (shopifyVariantIds.length > 0) {
                            const inventoryLevels = await this.shopifyApiClient.getInventoryLevels(
                                connection,
                                shopifyVariantIds
                            );
                            for (const level of inventoryLevels) {
                                const mapping = mappings.find(m => m.PlatformVariantId === level.variantId);
                                if (!mapping || !mapping.ProductVariantId || !mapping.ProductVariants || mapping.ProductVariants.length === 0) continue;
        
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
                        } else {
                             this.logger.warn(`No Shopify Variant IDs found in mappings for connection ${platformConnectionId}. Skipping Shopify inventory fetch for locations with products.`);
                        }
                    }
                    await supabase
                        .from('PlatformConnections')
                        .update({ LastSyncSuccessAt: new Date().toISOString() })
                        .eq('Id', platformConnectionId);
                }

                const { data: dbInventory, error: inventoryError } = await supabase
                    .from('InventoryLevels')
                    .select(`
                        ProductVariantId,
                        PlatformLocationId,
                        Quantity,
                        UpdatedAt,
                        ProductVariants!inner(
                            Id,
                            Sku,
                            Title,
                            Products!inner(Id)
                        ),
                        PlatformProductMappings!inner(
                            PlatformProductId,
                            PlatformVariantId
                        )
                    `)
                    .eq('PlatformConnectionId', platformConnectionId)
                    .eq('ProductVariants.Products.UserId', userId);

                if (inventoryError) {
                    this.logger.error(`Inventory fetch error for locations with products: ${JSON.stringify(inventoryError)}`);
                    throw new InternalServerErrorException('Failed to fetch inventory levels for locations with products from database.');
                }

                for (const item of dbInventory) {
                    const location = locationMap.get(item.PlatformLocationId);
                    const variantInfoArray = item.ProductVariants;
                    const mappingInfoArray = item.PlatformProductMappings;

                    const variantInfo = Array.isArray(variantInfoArray) && variantInfoArray.length > 0 ? variantInfoArray[0] : null;
                    const mappingInfo = Array.isArray(mappingInfoArray) && mappingInfoArray.length > 0 ? mappingInfoArray[0] : null;
                    const productInfo = variantInfo && Array.isArray((variantInfo as any).Products) && (variantInfo as any).Products.length > 0 ? (variantInfo as any).Products[0] : null;


                    if (location && variantInfo && mappingInfo && productInfo) {
                        location.products.push({
                            variantId: item.ProductVariantId,
                            sku: variantInfo.Sku,
                            title: variantInfo.Title,
                            quantity: item.Quantity,
                            updatedAt: item.UpdatedAt,
                            productId: productInfo.Id,
                            platformVariantId: mappingInfo.PlatformVariantId,
                            platformProductId: mappingInfo.PlatformProductId
                        });
                    }
                }

                const { data: connectionData } = await supabase
                    .from('PlatformConnections')
                    .select('LastSyncSuccessAt')
                    .eq('Id', platformConnectionId)
                    .single();

                return {
                    locations: resultLocations,
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
    @UseGuards(SupabaseAuthGuard)
    async queueProductSync(@Req() req: AuthenticatedRequest, @Body('productId') productId: string) {
        const userId = req.user.id;
        this.logger.log(`User ${userId} queueing product sync for product ${productId}`);
        await QueueManager.enqueueJob({ type: 'product-sync', productId, userId, timestamp: Date.now() });
        return { success: true, message: 'Product sync job queued.' };
    }

    @Get('sku-check')
    @HttpCode(HttpStatus.OK)
    @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
    async checkSkuUniqueness(
        @Query() query: SkuCheckDto,
        @Req() req: AuthenticatedRequest,
    ): Promise<{ isUnique: boolean; message?: string }> {
        const userId = req.user.id;
        const sku = query.sku;
        this.logger.log(`[GET /sku-check] User: ${userId} - Checking SKU: ${sku}`);

        const isUnique = await this.productsService.isSkuUniqueForUser(userId, sku);

        if (isUnique) {
            this.logger.log(`[GET /sku-check] User: ${userId} - SKU '${sku}' is unique.`);
            return { isUnique: true };
        } else {
            this.logger.log(`[GET /sku-check] User: ${userId} - SKU '${sku}' is already in use.`);
            return { isUnique: false, message: 'This SKU is already in use by you.' };
        }
    }

    // ... (TODO endpoints) ...
}