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
import { PlatformConnectionsService, PlatformConnection } from '../platform-connections/platform-connections.service';
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

    private _logCharCodes(str: string, count: number, logger: Logger, stage: string) {
        if (!str) return;
        const len = str.length;
        const start = Math.max(0, len - count);
        logger.log(`    [CharCodes - ${stage}] Last ${Math.min(count, len)} chars of "${str.substring(start)}":`);
        for (let i = start; i < len; i++) {
            logger.log(`      Char at ${i}: ${str.charCodeAt(i)} ('${str[i]}')`);
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
        this.logger.debug(`[publishToShopify] Received publishData: ${JSON.stringify(publishData, null, 2)}`);

        const supabase = this.supabaseService.getServiceClient(); // Use service client for backend operations
        const userId = req.user.id;
        const { platformConnectionId, locations, options } = publishData;

        // Final cleaning of image URLs before passing to Shopify API
        const cleanedImageUris = options?.imageUris?.map(uri => this._controllerCleanImageUrl(uri, this.logger)) || [];
        this.logger.log(`[publishToShopify] Final cleaned image URIs for Shopify request: ${cleanedImageUris.join(', ')}`);
        // Update the publishData with cleaned URIs
        if (options && options.imageUris) {
            options.imageUris = cleanedImageUris as string[];
        }

        try {
            this.logger.log(`[publishToShopify] Inside try block for productId: ${productId}`);

            // Fetch the PlatformConnection object
            const connection = await this.platformConnectionsService.getConnectionById(platformConnectionId, userId);
            if (!connection) {
                this.logger.error(`[publishToShopify] PlatformConnection ${platformConnectionId} not found for user ${userId}.`);
                throw new NotFoundException('Platform connection not found or access denied.');
            }
            if (connection.PlatformType !== 'shopify') {
                this.logger.error(`[publishToShopify] PlatformConnection ${platformConnectionId} is not a Shopify connection.`);
                throw new BadRequestException('Invalid platform connection type. Expected Shopify.');
            }

            const { data: product, error: productError } = await supabase
                .from('Products')
                .select('*')
                .eq('Id', productId)
                .eq('UserId', userId)
                .single();

            if (productError || !product) {
                this.logger.error(`[publishToShopify] Product ${productId} not found for user ${userId}: ${productError?.message}`);
                throw new NotFoundException('Product not found or access denied.');
            }
            this.logger.log(`[publishToShopify] Fetched product: ${JSON.stringify(product)}`);

            const { data: variants, error: variantsError } = await supabase
                .from('ProductVariants')
                .select('*')
                .eq('ProductId', productId)
                .eq('UserId', userId);

            if (variantsError || !variants || variants.length === 0) {
                this.logger.error(`[publishToShopify] No variants found for product ${productId}: ${variantsError?.message}`);
                throw new NotFoundException('No variants found for this product.');
            }
            this.logger.log(`[publishToShopify] Fetched variants: ${JSON.stringify(variants)}`);

            const shopifyVariantsInput: any[] = [];
            let productLevelMediaForShopify: { originalSource: string; altText: string; }[] = [];

            // Determine product-level images first (if options.imageUris are provided)
            if (options?.imageUris && options.imageUris.length > 0) {
                this.logger.log('[publishToShopify] Using frontend-provided imageUris for product-level media.');
                options.imageUris.forEach(uri => {
                    let cleanedUri = this._controllerCleanImageUrl(uri, this.logger);
                    if (cleanedUri) {
                        cleanedUri = cleanedUri.replace(/^"|"$/g, '').replace(/;$/, '');
                        this.logger.log(`[publishToShopify] Processed frontend-provided media: ${cleanedUri}`);
                        productLevelMediaForShopify.push({ originalSource: cleanedUri, altText: product.Title || 'Product image' });
                    }

                });
                this.logger.log(`[publishToShopify] Processed frontend-provided media: ${JSON.stringify(productLevelMediaForShopify)}`);
            } else {
                this.logger.log('[publishToShopify] No frontend-provided imageUris in options, will attempt to use DB images per variant.');
            }


            for (const cv of variants) { // cv for canonicalVariant
                let imageSourceForVariantFile: string | null = null;
                let imageAltTextForVariantFile: string = cv.Title || product.Title || 'Product image';

                // Determine the image source, primarily for logging or a future separate image update step
                if (variants.indexOf(cv) === 0 && productLevelMediaForShopify.length > 0) {
                    const coverIndex = options?.coverImageIndex ?? 0;
                    if (coverIndex >= 0 && coverIndex < productLevelMediaForShopify.length) {
                        imageSourceForVariantFile = productLevelMediaForShopify[coverIndex].originalSource;
                        // imageAltTextForVariantFile is already set
                    } else if (productLevelMediaForShopify.length > 0) { // Fallback
                        imageSourceForVariantFile = productLevelMediaForShopify[0].originalSource;
                    }
                    this.logger.log(`[publishToShopify] Determined imageSource (from frontend options) for variant ${cv.Id}: ${imageSourceForVariantFile}`);
                } else if (!productLevelMediaForShopify.length) {
                    this.logger.log(`[publishToShopify] Attempting to fetch DB image for variant ${cv.Id} as no frontend images provided initially.`);
                    const { data: dbImages, error: dbImagesError } = await supabase
                        .from('ProductImages')
                        .select('ImageUrl, AltText, Id')
                        .eq('ProductVariantId', cv.Id)
                        .order('Position', { ascending: true });

                    if (dbImagesError) {
                        this.logger.warn(`[publishToShopify] Error fetching images for variant ${cv.Id} from DB: ${dbImagesError.message}`);
                    } else if (dbImages && dbImages.length > 0) {
                        const imageToUse = cv.ImageId ? dbImages.find(img => img.Id === cv.ImageId) : dbImages[0];
                        const finalDbImage = imageToUse || dbImages[0];
                        if (finalDbImage && finalDbImage.ImageUrl) {
                            imageSourceForVariantFile = this._controllerCleanImageUrl(finalDbImage.ImageUrl, this.logger);
                            // imageAltTextForVariantFile is already set or uses default
                            this.logger.log(`[publishToShopify] Using DB image for variant ${cv.Id} (after controller cleaning): ${imageSourceForVariantFile}`);
                        }
                    }
                }

                // Constructing Shopify variant input
                const shopifyOptionValues: { optionName: string; name: string }[] = [];
                if (cv.Options && typeof cv.Options === 'object') {
                    const variantOptions = cv.Options as Record<string, string>;
                    Object.entries(variantOptions).forEach(([key, value]) => {
                        if (key !== 'shopify') { // Assuming 'shopify' is not a real product option
                           shopifyOptionValues.push({ optionName: key, name: value });
                        }
                    });
                }
                 // If no structured options, use a default based on title for single-variant products
                if (shopifyOptionValues.length === 0 && variants.length === 1) {
                    shopifyOptionValues.push({ optionName: 'Title', name: cv.Title || 'Default' });
                }


                const variantInput: any = {
                    optionValues: shopifyOptionValues,
                    price: cv.Price?.toString(), // Shopify expects price as string
                    sku: cv.Sku,
                        inventoryItem: {
                        tracked: true, // Assuming all items are tracked
                        measurement: cv.Weight && cv.WeightUnit ? {
                                weight: {
                                value: parseFloat(cv.Weight.toString()),
                                unit: cv.WeightUnit.toUpperCase() // e.g., POUNDS, KILOGRAMS
                                }
                            } : undefined
                        },
                        inventoryQuantities: locations.map(loc => ({
                            locationId: loc.locationId,
                        name: "available", // Shopify typically uses "available" for the main quantity field via API
                            quantity: loc.quantity
                        })),
                    taxable: cv.IsTaxable ?? true, // Default to true if not set
                    barcode: cv.Barcode || undefined,
                };

                // TEMPORARILY OMITTING `variantInput.file` TO AVOID SEMICOLON ISSUE
                // The logic for imageSourceForVariantFile and its cleaning is kept for logging 
                // and for a potential future separate image update step.
                this.logger.warn(`[publishToShopify] TEMPORARILY OMITTING variantInput.file for Shopify variant ${cv.Sku || cv.Id} to isolate semicolon issue.`);
                
                // if (imageSourceForVariantFile) {
                //     let finalCleanedUrl = this._controllerCleanImageUrl(imageSourceForVariantFile, this.logger) || '';
                //     if (finalCleanedUrl.includes(';')) {
                //         finalCleanedUrl = finalCleanedUrl.split(';')[0];
                //         this.logger.warn(`[CRITICAL FIX] Found semicolon after cleaning - truncating URL at semicolon`);
                //     }
                //     variantInput.file = {
                //         originalSource: finalCleanedUrl, 
                //         alt: imageAltTextForVariantFile || cv.Title || 'Product image',
                //         filename: `${cv.Sku || 'product'}.jpg`,
                //         contentType: 'IMAGE'
                //     };
                //     this.logger.log(`[publishToShopify] Prepared variantInput.file.originalSource (but currently omitted): ${finalCleanedUrl}`);
                // } else {
                //     this.logger.warn(`[publishToShopify] No image source determined for Shopify variant ${cv.Sku || cv.Id}. Variant would be created without an image file.`);
                // }
                shopifyVariantsInput.push(variantInput);
            }

            const shopifyProductOptionsRaw = this.productsService.determineShopifyProductOptions(variants);
            const shopifyProductOptionsFormatted = shopifyProductOptionsRaw.map(opt => ({
                name: opt.name,
                values: opt.values.map(val => ({ name: val })) // Adjust if ShopifyProductOptionValue is different
            }));

            const productDescriptionHtml = (product.Description || variants[0]?.Description || product.Title || '');

            const productInputForShopify: ShopifyProductSetInput = { // Explicitly type for clarity
                title: product.Title || variants[0]?.Title || 'Untitled Product',
                descriptionHtml: productDescriptionHtml,
                status: options?.status || 'ACTIVE',
                vendor: options?.vendor || (variants[0]?.Options as any)?.shopify?.vendor || undefined,
                productType: options?.productType || (variants[0]?.Options as any)?.shopify?.productType || undefined,
                tags: options?.tags || (variants[0]?.Options as any)?.shopify?.tags || [],
                productOptions: shopifyProductOptionsFormatted, // Use the formatted options
                variants: shopifyVariantsInput,
            };

            this.logger.debug(`[publishToShopify] Constructed productInput for Shopify: ${JSON.stringify(productInputForShopify, null, 2)}`);

            const shopifyResponse = await this.shopifyApiClient.createProductAsync(
                connection, // Pass the fetched PlatformConnection object
                productInputForShopify,
                // req.user.id // Pass userId if your apiClient needs it for logging/context
            ) as ShopifyProductCreationResponseFromClient; // Cast to the extended interface

            this.logger.log(`[publishToShopify] Shopify publish response for product ${productId}: ${JSON.stringify(shopifyResponse)}`);
            
            // If product creation was successful and we have a Shopify Product ID, and images were provided in options
            if (shopifyResponse.productId && productLevelMediaForShopify.length > 0) {
                this.logger.log(`[publishToShopify] Product created (ID: ${shopifyResponse.productId}). Now attempting to associate ${productLevelMediaForShopify.length} product-level images.`);
                try {
                    // Convert productLevelMediaForShopify to ShopifyProductFile[] format
                    const shopifyImageInputs: ShopifyProductFile[] = productLevelMediaForShopify.map((media, index) => ({
                        originalSource: media.originalSource, // This was cleaned when productLevelMediaForShopify was populated
                        alt: media.altText || `Product image ${index + 1}`,
                        filename: `${product.Title || 'product'}_${index + 1}.jpg`.replace(/[^a-zA-Z0-9_\.\-]/g, '_'), // Basic filename sanitization
                        contentType: 'IMAGE' 
                    }));

                    this.logger.debug(`[publishToShopify] Calling shopifyApiClient.updateProductImagesAsync with productId: ${shopifyResponse.productId} and images: ${JSON.stringify(shopifyImageInputs)}`);
                    // Placeholder for the actual call - this method needs to exist in ShopifyApiClient
                    // const imageUpdateResponse = await this.shopifyApiClient.updateProductImagesAsync(connection, shopifyResponse.productId, shopifyImageInputs);
                    // this.logger.log(`[publishToShopify] Shopify image update response: ${JSON.stringify(imageUpdateResponse)}`);
                    this.logger.warn(`[publishToShopify] shopifyApiClient.updateProductImagesAsync is not yet implemented. Images were not uploaded to product ID: ${shopifyResponse.productId}`);

                } catch (imgError: any) {
                    this.logger.error(`[publishToShopify] Failed to update/associate images for Shopify product ${shopifyResponse.productId}: ${imgError.message}`, imgError.stack);
                    // Do not re-throw here to let the main product creation be considered a partial success
                }
            }

            // Update PlatformProductMappings with Shopify IDs
            if (shopifyResponse.productId && shopifyResponse.variants && shopifyResponse.variants.length > 0) {
                for (const shopifyVariant of shopifyResponse.variants) {
                    // Try to find the canonical variant by SKU.
                    // This assumes SKUs are unique within the product on SSSync side for this mapping.
                    const canonicalVariant = variants.find(v => v.Sku === shopifyVariant.sku);
                    if (canonicalVariant) {
                        await this.platformProductMappingsService.upsertMapping({ // Renamed method
                    PlatformConnectionId: platformConnectionId,
                            ProductVariantId: canonicalVariant.Id,
                            PlatformProductId: shopifyResponse.productId,
                            PlatformVariantId: shopifyVariant.id, // Use ID from the looped shopifyVariant
                            PlatformSku: shopifyVariant.sku,     // Use SKU from the looped shopifyVariant
                            LastSyncedAt: new Date().toISOString(),
                            SyncStatus: 'synced', // Or 'pending_confirmation' if needed
                            IsEnabled: true,
                        }, userId); // Assuming upsertMapping might need userId for audit/context
                        this.logger.log(`[publishToShopify] Upserted mapping for SKU ${shopifyVariant.sku} (CanonicalVariantID: ${canonicalVariant.Id}) with Shopify ProductID: ${shopifyResponse.productId}, ShopifyVariantID: ${shopifyVariant.id}.`);
                    } else {
                        this.logger.warn(`[publishToShopify] Could not find canonical variant matching SKU ${shopifyVariant.sku} from Shopify response for product ${productId}. Skipping mapping for this variant.`);
                    }
                }
            } else {
                this.logger.warn(`[publishToShopify] Shopify response for product ${productId} did not contain product ID or variant details necessary for mapping. Shopify Response: ${JSON.stringify(shopifyResponse)}`);
            }


            return {
                success: true,
                productId: shopifyResponse.productId,
                operationId: shopifyResponse.operationId,
                status: shopifyResponse.status,
                message: 'Product published to Shopify successfully.'
            };

        } catch (error: any) {
            this.logger.error(`[publishToShopify] Failed to publish product ${productId} to Shopify: ${error.message}`, error.stack);
            // Consider re-throwing a more specific HttpException
            throw new InternalServerErrorException(error.message || 'Failed to publish product to Shopify due to an internal error.');
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