// src/products/products.controller.ts
import { Controller, Post, Body, Query, UsePipes, ValidationPipe, Logger, BadRequestException, HttpCode, HttpStatus, UseGuards, Request, Get, Param, NotFoundException, InternalServerErrorException, HttpException } from '@nestjs/common';
import { ProductsService } from './products.service';
import { AnalyzeImagesDto } from './dto/analyze-images.dto';
import { GenerateDetailsDto } from './dto/generate-details.dto';
import { SerpApiLensResponse } from './image-recognition/image-recognition.service';
import { GeneratedDetails } from './ai-generation/ai-generation.service';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { FeatureUsageGuard, Feature } from '../common/guards/feature-usage.guard';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { PublishProductDto } from './dto/publish-product.dto';
import { ProductVariant } from '../common/types/supabase.types';
import { ShopifyProductSetInput } from '../platform-adapters/shopify/shopify-api-client.service';
import { AuthGuard } from '../auth/auth.guard';
import { PlatformConnectionsService } from '../platform-connections/platform-connections.service';
import { ShopifyApiClient } from '../platform-adapters/shopify/shopify-api-client.service';
import { PlatformProductMappingsService } from '../platform-product-mappings/platform-product-mappings.service';

// Use the actual ProductVariant type from Supabase types
type SimpleProductVariant = Pick<ProductVariant, 'Id' | 'ProductId' | 'Sku' | 'Title' | 'Price'>;

interface SimpleProduct {
    Id: string;
    UserId: string;
    IsArchived: boolean;
}

interface SimpleAiGeneratedContent {
    Id: string;
    ContentType: string;
    GeneratedText: string;
}

@Controller('products')
export class ProductsController {
    private readonly logger = new Logger(ProductsController.name);

    constructor(
        private readonly productsService: ProductsService,
        private readonly platformConnectionsService: PlatformConnectionsService,
        private readonly shopifyApiClient: ShopifyApiClient,
        private readonly platformProductMappingsService: PlatformProductMappingsService
    ) {}

    /**
     * Endpoint 1 (Revised): Analyzes images, creates draft, saves analysis.
     */
    @Post('analyze')
    @Feature('aiScans')
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard)
    @Throttle({ default: { limit: 10, ttl: 60000 }})
    @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    @HttpCode(HttpStatus.OK)
    async analyzeAndCreateDraft(
        @Request() req,
        @Body() analyzeImagesDto: AnalyzeImagesDto,
    ): Promise<{ product: SimpleProduct; variant: SimpleProductVariant; analysis?: SimpleAiGeneratedContent }> {
        const userId = (req.user as any)?.id;
        if (!userId) {
            throw new BadRequestException('User ID not found after authentication.');
        }

        this.logger.log(`Analyze images request for user: ${userId}`);
        if (!analyzeImagesDto || !analyzeImagesDto.imageUris || analyzeImagesDto.imageUris.length === 0) {
            throw new BadRequestException('At least one image URI is required in the request body.');
        }

        // Pass the primary image URI to the service for analysis
        // The service currently only takes one imageUrl for SerpApi
        const primaryImageUrl = analyzeImagesDto.imageUris[0];

        // Pass any initial data from the DTO to the service if needed
        // The service expects an optional object like { title, description, price, sku }
        const initialData = {
            // Map fields from analyzeImagesDto if they exist, e.g.:
            // title: analyzeImagesDto.initialTitle,
            // sku: analyzeImagesDto.initialSku,
        };

        // Directly return the result from the service, as its type now matches the declaration
        return this.productsService.analyzeAndCreateDraft(
            userId,
            primaryImageUrl,
            initialData,
        );
    }

    /**
     * Endpoint 2 (Revised): Generates AI details for an existing draft product/variant.
     */
    @Post('generate-details')
    @Feature('aiScans')
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard)
    @Throttle({ default: { limit: 5, ttl: 60000 }})
    @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    async generateDetailsForDraft(
         @Request() req,
         @Body() generateDetailsDto: GenerateDetailsDto,
    ): Promise<{ generatedDetails: GeneratedDetails | null }> {
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
    @UseGuards(AuthGuard)
    async publishToShopify(
        @Param('id') productId: string,
        @Body() publishData: {
            platformConnectionId: string;
            locations: Array<{
                locationId: string;
                quantity: number;
            }>;
            options?: {
                status?: 'ACTIVE' | 'DRAFT';
                vendor?: string;
                productType?: string;
                tags?: string[];
            };
        },
        @Request() req: any
    ) {
        try {
            const userId = req.user.sub;
            const { platformConnectionId, locations, options } = publishData;

            // Get the product and its variants
            const product = await this.productsService.getProduct(productId, userId);
            if (!product) {
                throw new NotFoundException(`Product ${productId} not found`);
            }

            // Get the platform connection
            const connection = await this.platformConnectionsService.getConnectionById(platformConnectionId, userId);
            if (!connection || connection.PlatformType !== 'SHOPIFY') {
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

            // Prepare product input for Shopify
            const productInput: ShopifyProductSetInput = {
                title: product.Title,
                descriptionHtml: product.Description,
                status: options?.status || 'ACTIVE',
                vendor: options?.vendor,
                productType: options?.productType,
                tags: options?.tags,
                productOptions: product.Variants[0]?.Options ? [
                    {
                        name: 'Option',
                        values: product.Variants.map(v => ({ name: v.Title }))
                    }
                ] : undefined,
                variants: product.Variants.map(variant => ({
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
                    barcode: variant.Barcode,
                    file: variant.ImageUrl ? {
                        originalSource: variant.ImageUrl,
                        alt: `${product.Title} - ${variant.Title}`,
                        filename: `${variant.Sku}.jpg`,
                        contentType: 'IMAGE'
                    } : undefined
                }))
            };

            // Create the product in Shopify
            const result = await this.shopifyApiClient.createProductAsync(connection, productInput);

            // Create platform mapping
            if (result.productId) {
                await this.platformProductMappingsService.createMapping({
                    PlatformConnectionId: platformConnectionId,
                    ProductVariantId: product.Variants[0].Id, // Map the first variant
                    PlatformProductId: result.productId,
                    PlatformVariantId: result.productId, // For now, using the same ID
                    PlatformSku: product.Variants[0].Sku,
                    PlatformSpecificData: {
                        operationId: result.operationId,
                        status: result.status
                    }
                });
            }

            return {
                success: true,
                operationId: result.operationId,
                status: result.status,
                productId: result.productId,
                userErrors: result.userErrors
            };
        } catch (error) {
            this.logger.error(`Error publishing product to Shopify: ${error.message}`, error.stack);
            throw error instanceof HttpException ? error : new InternalServerErrorException('Failed to publish product to Shopify');
        }
    }

    // ... (TODO endpoints) ...
}