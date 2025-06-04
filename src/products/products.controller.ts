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
import { ShopifyProductSetInput, ShopifyProductFile, ShopifyLocationNode, ShopifyInventoryLevelNode, ShopifyVariantInput, ShopifyInventoryQuantity, ShopifyMediaInput, ShopifyProductOption, ShopifyProductOptionValue, ShopifyInventoryItem } from '../platform-adapters/shopify/shopify-api-client.service';
import { PlatformConnectionsService, PlatformConnection } from '../platform-connections/platform-connections.service';
import { ShopifyApiClient } from '../platform-adapters/shopify/shopify-api-client.service';
import { PlatformProductMappingsService } from '../platform-product-mappings/platform-product-mappings.service';
import { SupabaseService } from '../common/supabase.service';
import * as QueueManager from '../queue-manager';
import { Request as ExpressRequest } from 'express';
import { User } from '@supabase/supabase-js';
import { SubscriptionLimitGuard } from '../common/subscription-limit.guard';
import { SkuCheckDto } from './dto/sku-check.dto';
import { ConflictException } from '@nestjs/common';

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

// Define an interface for the expected structure of the Shopify API client's response
interface ShopifyProductCreationResponseFromClient {
  operationId: string;
  status: string;
  productId?: string;
  userErrors: { field: string[] | null; message: string; code: string; }[];
  variants?: Array<{ // Assuming variants are returned like this for mapping
    id: string;
    sku: string;
    title?: string;
    // Add other fields if necessary for mapping or logging
  }>;
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
        // Clean imageUris before processing
        if (publishProductDto.media?.imageUris) {
            publishProductDto.media.imageUris = publishProductDto.media.imageUris
                .map(uri => this._controllerCleanImageUrl(uri, this.logger) || '')
                .filter(uri => uri.length > 0);
        }

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

    // Update the cleaning helper to remove quotes and semicolons completely
    private _controllerCleanImageUrl(url: string | null | undefined, logger: Logger): string | null {
        if (!url) {
            logger.log(`[_controllerCleanImageUrl] Input URL is null or undefined.`);
            return null;
        }
        logger.log(`[_controllerCleanImageUrl] Initial URL: "${url}" (Length: ${url.length})`);
        this._logCharCodes(url, 5, logger, "Initial");

        let cleaned = url;

        // Attempt 1: Replace known semicolon forms (ASCII, common Unicode look-alike, URL encoded)
        // Common Unicode semicolons: ； (Fullwidth semicolon), ; (Greek Question Mark which looks like a semicolon)
        cleaned = cleaned.replace(/;|%3B|；|;/g, '');
        logger.log(`[_controllerCleanImageUrl] After replacing known semicolons: "${cleaned}" (Length: ${cleaned.length})`);
        this._logCharCodes(cleaned, 5, logger, "After Semicolon Replace");

        // Attempt 2: Replace quotes
        cleaned = cleaned.replace(/"|'/g, '');
        logger.log(`[_controllerCleanImageUrl] After replacing quotes: "${cleaned}" (Length: ${cleaned.length})`);
        this._logCharCodes(cleaned, 5, logger, "After Quote Replace");

        // Attempt 3: Trim whitespace (including Unicode spaces)
        cleaned = cleaned.trim(); // trim() handles various whitespace characters
        logger.log(`[_controllerCleanImageUrl] After trim: "${cleaned}" (Length: ${cleaned.length})`);
        this._logCharCodes(cleaned, 5, logger, "After Trim");

        // Attempt 4: Aggressive character-by-character check for anything that looks like a semicolon or is not a standard URL char
        // This is a more robust way than just includes(';')
        if (/[^A-Za-z0-9\/:\.\?=\&_\-%~#]/.test(cleaned.slice(-1))) { // Check last character
             logger.warn(`[_controllerCleanImageUrl] Last character might be problematic: '${cleaned.slice(-1)}' (Code: ${cleaned.charCodeAt(cleaned.length - 1)}). Original: "${url}"`);
             // If it's a semicolon by char code, or still one of the problematic ones, attempt to remove it directly.
             // We are primarily concerned about a trailing character here.
             if (cleaned.charCodeAt(cleaned.length - 1) === 59 || cleaned.charCodeAt(cleaned.length - 1) === 65307 || cleaned.charCodeAt(cleaned.length - 1) === 958) {
                logger.warn(`[_controllerCleanImageUrl] Attempting to slice off trailing problematic char.`);
                cleaned = cleaned.slice(0, -1);
                logger.log(`[_controllerCleanImageUrl] After slicing trailing char: "${cleaned}"`);
                this._logCharCodes(cleaned, 5, logger, "After Slice");
             }
        }

        logger.log(`[_controllerCleanImageUrl] Final Cleaned URL for return: "${cleaned}" (Length: ${cleaned.length})`);
        this._logCharCodes(cleaned, 5, logger, "Final Return");
        return cleaned;
    }

    private _logCharCodes(text: string, count: number, logger: Logger, context: string) {
        // Simplified implementation for brevity, assuming it exists and works
        const relevantPortion = text.length > count ? text.slice(-count) : text;
        logger.log(`    [CharCodes - ${context}] Last ${relevantPortion.length} chars of "${relevantPortion}":`);
        for (let i = 0; i < relevantPortion.length; i++) {
            const char = relevantPortion[i];
            logger.log(`      Char at ${text.length - relevantPortion.length + i}: ${char.charCodeAt(0)} ('${char}')`);
        }
    }

    private mapWeightUnitToShopify(unit?: string | null): 'KILOGRAMS' | 'GRAMS' | 'POUNDS' | 'OUNCES' | undefined {
        if (!unit) return undefined;
        const lowerUnit = unit.toLowerCase();
        switch (lowerUnit) {
            case 'kg':
            case 'kgs':
            case 'kilogram':
            case 'kilograms':
                return 'KILOGRAMS';
            case 'g':
            case 'gr':
            case 'grams':
                return 'GRAMS';
            case 'lb':
            case 'lbs':
            case 'pound':
            case 'pounds':
                return 'POUNDS';
            case 'oz':
            case 'ounce':
            case 'ounces':
                return 'OUNCES';
            default:
                this.logger.warn(`[mapWeightUnitToShopify] Unmapped weight unit: '${unit}'. Shopify requires KILOGRAMS, GRAMS, POUNDS, or OUNCES.`);
                return undefined;
        }
    }

    @Post(':id/publish/shopify')
    @UseGuards(FeatureUsageGuard)
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
                imageUris?: string[];
                coverImageIndex?: number;
            };
        },
        @Req() req: AuthenticatedRequest
    ) {
        this.logger.log(`[publishToShopify] Entered method for productId: ${productId}, user: ${req.user.id}`);
        this.logger.debug(`[publishToShopify] Received publishData: ${JSON.stringify(publishData)}`);

        const userId = req.user.id;
        const options = publishData.options || {};

        try {
            const connection = await this.platformConnectionsService.getConnectionById(publishData.platformConnectionId, userId);
            if (!connection || connection.PlatformType !== 'shopify') {
                this.logger.warn(`[publishToShopify] Invalid or non-Shopify connection ID: ${publishData.platformConnectionId} for user ${userId}`);
                throw new BadRequestException('Invalid or non-Shopify platformConnectionId.');
            }
            if (!connection.IsEnabled) {
                this.logger.warn(`[publishToShopify] Shopify connection ${publishData.platformConnectionId} is disabled for user ${userId}.`);
                throw new BadRequestException(`Shopify connection ${publishData.platformConnectionId} is disabled.`);
            }

            const { product: canonicalProduct, variants: canonicalVariantsFullAny } = await this.productsService.getProduct(productId, userId);
            const canonicalVariantsFull = canonicalVariantsFullAny as ProductVariant[];

            if (!canonicalProduct) {
                this.logger.warn(`[publishToShopify] Canonical product ${productId} not found for user ${userId}.`);
                throw new NotFoundException(`Product with ID ${productId} not found.`);
            }
            if (!canonicalVariantsFull || canonicalVariantsFull.length === 0) {
                this.logger.warn(`[publishToShopify] No variants found for canonical product ${productId}.`);
                throw new BadRequestException(`No variants found for product ${productId}. Cannot publish to Shopify.`);
            }

            this.logger.log(`[publishToShopify] Canonical product and variants fetched for product ID: ${productId}`);

            let productLevelShopifyFiles: ShopifyProductFile[] = [];
            if (options.imageUris && options.imageUris.length > 0) {
                this.logger.log(`[publishToShopify] Processing frontend-provided imageUris for product-level media.`);
                productLevelShopifyFiles = options.imageUris.map((uri, index) => {
                    const cleanedUrl = this._controllerCleanImageUrl(uri, this.logger);
                    if (!cleanedUrl) {
                        this.logger.warn(`[publishToShopify] Null or invalid URL encountered and skipped: ${uri}`);
                        return null;
                    }
                    const filename = cleanedUrl.substring(cleanedUrl.lastIndexOf('/') + 1).split('?')[0] || `product_image_${index + 1}.jpg`;
                    this.logger.log(`[publishToShopify] Cleaned product-level image URL: "${cleanedUrl}", filename: "${filename}" (original: "${uri}")`);
                    return {
                        originalSource: cleanedUrl,
                        alt: canonicalProduct.Title || `Product image ${index + 1}`,
                        filename: filename.replace(/[^a-zA-Z0-9_\.\-]/g, '_'), // Sanitize filename
                        contentType: 'IMAGE' as const,
                    };
                }).filter(file => file !== null) as ShopifyProductFile[];
                this.logger.log(`[publishToShopify] Processed frontend-provided media for product level: ${JSON.stringify(productLevelShopifyFiles.map(f=>f.originalSource))}`);
            } else {
                this.logger.log(`[publishToShopify] No frontend-provided imageUris for product level.`);
            }

            const determinedOptions = this.productsService.determineShopifyProductOptions(canonicalVariantsFull);
            // Shopify's ProductOptionInput expects { name: string, values: [{name: string}] }
            this.logger.debug(`[publishToShopify] Determined product-level options by service: ${JSON.stringify(determinedOptions)}`);

            const shopifyProductOptions: ShopifyProductOption[] = determinedOptions.map(opt => ({
                name: opt.name,
                values: opt.values.map(valName => ({ name: valName })) // Corrected mapping for ShopifyProductOptionValue
            }));
            this.logger.debug(`[publishToShopify] Determined Shopify product options for API: ${JSON.stringify(shopifyProductOptions)}`);

            const shopifyVariants: ShopifyVariantInput[] = canonicalVariantsFull.map((cv, variantIndex) => {
                this.logger.debug(`[publishToShopify] Processing variant (canonical): SKU '${cv.Sku}', Title '${cv.Title}'`);
                this.logger.debug(`[publishToShopify] Canonical Variant (cv) Options for SKU ${cv.Sku}: ${JSON.stringify(cv.Options)}`);

                let variantImageFile: ShopifyProductFile | undefined = undefined;
                // Try to find a specific image for this variant from the product-level list if one was designated as cover for it implicitly or explicitly
                // This logic assumes the options.imageUris are the primary source for images.
                if (options.imageUris && options.imageUris.length > 0) {
                     // Example: if the variant is the first one and there's a cover image index, use that.
                     // Or if a more complex mapping from canonicalVariant.ImageId to one of the productLevelShopifyFiles is needed.
                    let designatedImageUri: string | undefined;
                    if (variantIndex === (options.coverImageIndex ?? 0) && productLevelShopifyFiles.length > (options.coverImageIndex ?? 0)){
                        designatedImageUri = productLevelShopifyFiles[options.coverImageIndex ?? 0]?.originalSource;
                    } else if (cv.ImageId && productLevelShopifyFiles.some(f => f.originalSource.includes(cv.ImageId!))) {
                        // A more robust lookup: find a file whose source URL might contain the canonical ImageId
                        const matchedFile = productLevelShopifyFiles.find(f => f.originalSource.includes(cv.ImageId!));
                        designatedImageUri = matchedFile?.originalSource;
                    } else if (variantIndex < productLevelShopifyFiles.length && !options.coverImageIndex) {
                        // Fallback: assign images in order if no specific designation
                        // designatedImageUri = productLevelShopifyFiles[variantIndex]?.originalSource;
                    }

                    if (designatedImageUri) {
                        const foundFile = productLevelShopifyFiles.find(f => f.originalSource === designatedImageUri);
                        if (foundFile) {
                            variantImageFile = { ...foundFile, alt: cv.Title || foundFile.alt }; // Use variant title for alt if available
                            this.logger.log(`[publishToShopify] Variant ${cv.Sku} will use image: ${variantImageFile.originalSource}`);
                        }
                    }
                }

                const inventoryQuantities: ShopifyInventoryQuantity[] = publishData.locations
                    .map(loc => ({
                        locationId: loc.locationId,
                        quantity: loc.quantity,
                        name: 'available' as const
                    }));
                
                const shopifyOptionValues = cv.Options
                    ? Object.entries(cv.Options).map(([name, value]) => ({
                          optionName: name,
                          name: String(value) // Ensure value is a string
                      }))
                    : [];
                this.logger.debug(`[publishToShopify] Mapped shopifyOptionValues for SKU ${cv.Sku}: ${JSON.stringify(shopifyOptionValues)}`);

                const mappedWeightUnit = this.mapWeightUnitToShopify(cv.WeightUnit);
                let inventoryItemMeasurement: ShopifyInventoryItem['measurement'] = undefined;
                if (cv.Weight && mappedWeightUnit) {
                    inventoryItemMeasurement = {
                        weight: {
                            value: cv.Weight,
                            unit: mappedWeightUnit // Now this is guaranteed to be a valid Shopify unit
                        }
                    };
                }

                const shopifyVariant: ShopifyVariantInput = {
                    optionValues: shopifyOptionValues,
                    price: String(cv.Price),
                    sku: cv.Sku || '',
                        inventoryItem: {
                            tracked: true,
                        cost: (cv as any).Cost?.toString(),
                        measurement: inventoryItemMeasurement, // Use the conditional measurement object
                    },
                    inventoryQuantities: inventoryQuantities,
                    taxable: cv.IsTaxable ?? true,
                    barcode: cv.Barcode || undefined,
                    file: variantImageFile, // Ensure variantImageFile.originalSource is cleaned if it's constructed here
                };
                return shopifyVariant;
            });

            const productInputForShopify: ShopifyProductSetInput = {
                title: canonicalProduct.Title || 'Untitled Product',
                descriptionHtml: canonicalProduct.Description || undefined,
                vendor: options.vendor || undefined,
                productType: options.productType || undefined,
                status: options.status || 'ACTIVE',
                tags: options.tags || [],
                productOptions: shopifyProductOptions.length > 0 ? shopifyProductOptions : undefined,
                files: productLevelShopifyFiles.length > 0 ? productLevelShopifyFiles : undefined, // Ensure originalSource here is cleaned
                variants: shopifyVariants,
            };
            this.logger.debug(`[publishToShopify] Constructed productInput for Shopify (with files): ${JSON.stringify(productInputForShopify, null, 2)}`);

            const existingMappings = await this.platformProductMappingsService.getMappingsByProductIdAndConnection(productId, connection.Id);
            const existingMapping = existingMappings.find(m => m.PlatformProductId);

            let shopifyResponse: any; 
            let shopifyProductIdForMedia: string | undefined; // Keep this for identifying the product ID from response

            if (existingMapping && existingMapping.PlatformProductId) {
                this.logger.log(`[publishToShopify] Product ${productId} already has a mapping to Shopify product ${existingMapping.PlatformProductId}. Attempting update with productSet.`);
                // Ensure updateProductAsync also uses productSet and handles files correctly if needed.
                // For now, createProductAsync is the one shown with file handling in your example.
                // If update also uses productSet, the input structure is the same.
                const updateResponse = await this.shopifyApiClient.updateProductAsync(connection, existingMapping.PlatformProductId, productInputForShopify);
                shopifyResponse = {
                    operationId: 'N/A - Update',
                    status: updateResponse.product ? 'SUCCESS' : 'ERROR',
                    productId: updateResponse.product?.id,
                    userErrors: updateResponse.userErrors,
                };
                shopifyProductIdForMedia = updateResponse.product?.id;
            } else {
                this.logger.log(`[publishToShopify] Product ${productId} not yet on Shopify for connection ${connection.Id}. Attempting creation with productSet.`);
                shopifyResponse = await this.shopifyApiClient.createProductAsync(connection, productInputForShopify);
                shopifyProductIdForMedia = shopifyResponse.productId; // Assuming createProductAsync returns it in this shape
            }

            this.logger.log(`[publishToShopify] Shopify API response for product ${productId}: ${JSON.stringify(shopifyResponse)}`);

            if (shopifyResponse.userErrors && shopifyResponse.userErrors.length > 0) {
                const errorMessage = `Shopify API returned errors for product ${productId}: ${shopifyResponse.userErrors.map(e => e.message).join('; ')}`;
                this.logger.error(`[publishToShopify] ${errorMessage}`);
                const skuError = shopifyResponse.userErrors.find(err => err.message.toLowerCase().includes('sku has already been taken'));
                if (skuError) {
                    throw new ConflictException(`SKU conflict on Shopify: ${skuError.message}`);
                }
                throw new HttpException(errorMessage, HttpStatus.BAD_REQUEST);
            }

            if (!shopifyProductIdForMedia) {
                const errorMessage = `Failed to obtain Shopify Product ID for product ${productId}. Status: ${shopifyResponse.status}`;
                this.logger.error(`[publishToShopify] ${errorMessage}`);
                throw new InternalServerErrorException(errorMessage);
            }

            this.logger.log(`[publishToShopify] Successfully created/updated product on Shopify with files. Shopify Product ID: ${shopifyProductIdForMedia}`);

            // The separate media append call is now removed as productSet handles it.

            if (shopifyProductIdForMedia) {
                await this.platformProductMappingsService.upsertMapping({
                    PlatformConnectionId: connection.Id,
                    ProductVariantId: canonicalVariantsFull[0].Id, 
                    PlatformProductId: shopifyProductIdForMedia,
                    PlatformSku: canonicalVariantsFull[0].Sku,
                    LastSyncedAt: new Date().toISOString(),
                    SyncStatus: 'Success',
                    IsEnabled: true,
                    PlatformSpecificData: { shop: connection.PlatformSpecificData?.shop }
                });
                this.logger.log(`[publishToShopify] Platform mapping updated/created for canonical product ${productId} and Shopify product ${shopifyProductIdForMedia}.`);
            }
            
            return { 
                message: `Product ${productId} successfully published/updated on Shopify. Shopify Product ID: ${shopifyProductIdForMedia}`,
                shopifyProductId: shopifyProductIdForMedia,
            };

        } catch (error) {
            this.logger.error(`[publishToShopify] Error publishing product ${productId} to Shopify: ${error.message}`, error.stack);
            if (error instanceof HttpException) throw error;
            throw new InternalServerErrorException(`Failed to publish product to Shopify: ${error.message}`);
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