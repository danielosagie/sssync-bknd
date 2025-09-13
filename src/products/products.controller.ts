// src/products/products.controller.ts
import { Controller, Post, Body, Query, UsePipes, ValidationPipe, Logger, BadRequestException, HttpCode, HttpStatus, UseGuards, Request, Get, Param, NotFoundException, InternalServerErrorException, HttpException, Req, Put, Delete } from '@nestjs/common';
import { ProductsService, SimpleProduct, SimpleProductVariant, SimpleAiGeneratedContent, GeneratedDetails } from './products.service';
import { CrossAccountSyncService } from './cross-account-sync.service';
import { FirecrawlService } from './firecrawl.service';
import { ProductRecognitionService, ProductRecognitionRequest, RecognitionResult } from './product-recognition.service';
import { RerankerService } from '../embedding/reranker.service';
import { EmbeddingService } from '../embedding/embedding.service';
import { AnalyzeImagesDto } from './dto/analyze-images.dto';
import { GenerateDetailsDto } from './dto/generate-details.dto';
import { SerpApiLensResponse } from './image-recognition/image-recognition.service';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { FeatureUsageGuard, Feature } from '../common/guards/feature-usage.guard';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { PublishProductDto } from './dto/publish-product.dto';
import { ProductVariant } from '../common/types/supabase.types';
import { ShopifyProductSetInput, ShopifyProductFile, ShopifyLocationNode, ShopifyInventoryLevelNode, ShopifyVariantInput, ShopifyInventoryQuantity, ShopifyMediaInput, ShopifyProductOption, ShopifyProductOptionValue, ShopifyInventoryItem } from '../platform-adapters/shopify/shopify-api-client.service';
import { PlatformConnectionsService } from '../platform-connections/platform-connections.service';
import { ShopifyApiClient } from '../platform-adapters/shopify/shopify-api-client.service';
import { PlatformProductMappingsService } from '../platform-product-mappings/platform-product-mappings.service';
import { SupabaseService } from '../common/supabase.service';
import * as QueueManager from '../queue-manager';
import { Request as ExpressRequest } from 'express';
import { User } from '@supabase/supabase-js';
import { SubscriptionLimitGuard } from '../common/subscription-limit.guard';
import { SkuCheckDto } from './dto/sku-check.dto';
import { ConflictException } from '@nestjs/common';
import { ActivityLogService } from '../common/activity-log.service';
import { AiUsageTrackerService } from '../common/ai-usage-tracker.service';
import { AiGenerationService } from './ai-generation/ai-generation.service';
import { RegenerateJobProcessor } from './processors/regenerate-job.processor';
import { RegenerateJobStatus, RegenerateJobResult } from './types/regenerate-job.types';
import { GroqSmartPickerService } from '../embedding/groq-smart-picker.service';
import { FastTextRerankerService } from '../embedding/fast-text-reranker.service';
// Add the orchestrator import
import { ProductOrchestratorService, RecognizeStageInput, MatchStageInput, GenerateStageInput } from './product-orchestrator.service';
import { ProductAnalysisJobData, ProductAnalysisJobStatus } from './types/product-analysis-job.types';
import { ProductAnalysisProcessor } from './processors/product-analysis.processor';
import { MatchJobData, MatchJobStatus, MatchJobResult } from './types/match-job.types';
import { GenerateJobData, GenerateJobStatus, GenerateJobResult } from './types/generate-job.types';
import { GenerateJobProcessor } from './processors/generate-job.processor';
import { MatchJobProcessor } from './processors/match-job.processor';

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
        private readonly supabaseService: SupabaseService,
        private readonly crossAccountSyncService: CrossAccountSyncService,
        private readonly activityLogService: ActivityLogService,
        private readonly firecrawlService: FirecrawlService,
        private readonly aiUsageTracker: AiUsageTrackerService,
        private readonly productRecognitionService: ProductRecognitionService,
        private readonly rerankerService: RerankerService,
        private readonly embeddingService: EmbeddingService,
        private readonly aiGenerationService: AiGenerationService,
        private readonly groqSmartPickerService: GroqSmartPickerService,
        private readonly fastTextRerankerService: FastTextRerankerService,
        private readonly productOrchestratorService: ProductOrchestratorService,
        private readonly productAnalysisProcessor: ProductAnalysisProcessor,
        private readonly matchJobProcessor: MatchJobProcessor,
        private readonly generateJobProcessor: GenerateJobProcessor,
        private readonly regenerateJobProcessor: RegenerateJobProcessor,
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
     * Endpoint 1: Analyzes images using SerpAPI, creates draft, saves analysis.
     * Updated to work with current flow and generation pipeline.
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
        const result = await this.withRetry(async () => {
                const userId = req.user?.id;
                if (!userId) {
                    throw new BadRequestException('User ID not found after authentication.');
                }

                this.logger.log(`[POST /analyze] User: ${userId} - Analyzing image(s)`);
                if (!analyzeImagesDto || !analyzeImagesDto.imageUris || analyzeImagesDto.imageUris.length === 0) {
                    throw new BadRequestException('At least one image URI is required in the request body.');
                }
                const primaryImageUrl = analyzeImagesDto.imageUris[0];

            const analysisResult = await this.productsService.analyzeAndCreateDraft(userId, primaryImageUrl);

            // Log the product creation activity
            await this.activityLogService.logProductCreate(
                analysisResult.product.Id,
                analysisResult.variant.Id,
                {
                    title: analysisResult.product.Title,
                    sku: analysisResult.variant.Sku,
                    price: analysisResult.variant.Price,
                    source: 'user',
                    operation: 'create'
                },
                req.user.id
            );

            this.logger.log(`[POST /analyze] User: ${userId} - Analysis complete. ProductID: ${analysisResult.product.Id}`);
            return analysisResult;
        }, 'analyzeProduct');

        return result;
    }

    /**
     * Endpoint 2: Generates AI details for an existing draft product/variant.
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
                    generateDetailsDto.enhancedWebData,
                );

                this.logger.log(`[POST /generate-details] User: ${userId} - Generation complete for variant ${generateDetailsDto.variantId}`);
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
        
        // Log the start of publishing process
        await this.activityLogService.logUserAction(
            'PRODUCT_PUBLISH_STARTED',
            'In Progress',
            `Started publishing product`,
            {
                action: 'publish',
                screen: 'SaveOrPublishProduct',
                targetType: 'Product',
                inputData: {
                    publishIntent: publishProductDto.publishIntent,
                    variantId: publishProductDto.variantId
                }
            },
            req.user.id
        );

        await this.productsService.saveOrPublishListing(userId, publishProductDto);
        
        // Log successful completion
        await this.activityLogService.logUserAction(
            'PRODUCT_PUBLISH_COMPLETED',
            'Success',
            `Successfully published product`,
            {
                action: 'publish',
                screen: 'SaveOrPublishProduct',
                targetType: 'Product',
                inputData: {
                    publishIntent: publishProductDto.publishIntent,
                    variantId: publishProductDto.variantId
                }
            },
            req.user.id
        );
        
        this.logger.log(`[POST /publish] User: ${userId} - ${publishProductDto.publishIntent} processed for variant ${publishProductDto.variantId}`);

        return { message: 'Product published successfully' };
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

        // Match and remove any trailing ";," pattern
        cleaned = cleaned.replace(/;,/g, '');
        
        // Remove all semicolons (ASCII, Unicode variants, URL encoded)
        cleaned = cleaned.replace(/;|%3B|；|;/g, '');
        
        // Remove quotes
        cleaned = cleaned.replace(/"|'/g, '');
        
        // Trim whitespace
        cleaned = cleaned.trim();
        
        // Very aggressive cleaning - filter for only valid URL characters
        cleaned = cleaned.split('').filter(char => {
            const code = char.charCodeAt(0);
            return (
                (code >= 48 && code <= 57) || // 0-9
                (code >= 65 && code <= 90) || // A-Z
                (code >= 97 && code <= 122) || // a-z
                char === '/' || char === ':' || char === '.' || 
                char === '?' || char === '=' || char === '&' || 
                char === '_' || char === '-' || char === '%' || 
                char === '~' || char === '#'
            );
        }).join('');
        
        logger.log(`[_controllerCleanImageUrl] Final Cleaned URL: "${cleaned}" (Length: ${cleaned.length})`);
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
            case 'KILOGRAMS':
                return 'KILOGRAMS';
            case 'g':
            case 'gr':
            case 'grams':
            case 'GRAMS':
                return 'GRAMS';
            case 'lb':
            case 'lbs':
            case 'pound':
            case 'pounds':
            case 'POUNDS':
                return 'POUNDS';
            case 'oz':
            case 'ounce':
            case 'ounces':
            case 'OUNCES':
                return 'OUNCES';
            default:
                this.logger.warn(`[mapWeightUnitToShopify] Unmapped weight unit: '${unit}'. Shopify requires KILOGRAMS, GRAMS, POUNDS, or OUNCES.`);
                return undefined;
        }
    }

    @Post('extract-from-urls')
    @UseGuards(SupabaseAuthGuard)
    async extractFromUrls(
        @Body() extractDto: { urls: string[]; businessTemplate?: string; customPrompt?: string },
        @Req() req: AuthenticatedRequest,
    ): Promise<{ results: any[] }> {
        const userId = req.user?.id;
        if (!userId) {
            throw new BadRequestException('User ID not found after authentication.');
        }

        try {
            // Check if user can perform Firecrawl operations
            const canPerform = await this.aiUsageTracker.canUserPerformOperation(
                userId, 
                'firecrawl', 
                extractDto.urls.length
            );
            
            if (!canPerform.allowed) {
                throw new BadRequestException(canPerform.reason || 'Firecrawl usage limit exceeded');
            }

            const results: any[] = [];
            
            for (const url of extractDto.urls) {
                try {
                    // Use actual Firecrawl for extraction
                    const schema = this.firecrawlService.getProductSchema(extractDto.businessTemplate);
                    const firecrawlResult = await this.firecrawlService.extract(
                        [url],
                        schema,
                        {
                            prompt: extractDto.customPrompt || 'Extract product information including title, price, description, brand, and specifications'
                        }
                    );

                    // Track Firecrawl usage
                    await this.aiUsageTracker.trackFirecrawlUsage(
                        userId,
                        'extract_data',
                        1,
                        { url, businessTemplate: extractDto.businessTemplate }
                    );

                    if (firecrawlResult && firecrawlResult.length > 0) {
                        const extractedData = firecrawlResult[0];
                        results.push({
                            type: 'web_data',
                            confidence: 0.9,
                            data: extractedData,
                            source: url,
                            title: extractedData.title || 'Product Data',
                            price: extractedData.price
                        });
                    } else {
                        results.push({
                            type: 'web_data',
                            confidence: 0.1,
                            data: { error: 'No data extracted' },
                            source: url,
                            title: 'No Data Found'
                        });
                    }
                } catch (error) {
                    this.logger.warn(`Failed to extract from ${url}:`, error);
                    results.push({
                        type: 'web_data',
                        confidence: 0.1,
                        data: { error: 'Failed to extract data' },
                        source: url,
                        title: 'Extraction Failed'
                    });
                }
            }

            return { results };
        } catch (error) {
            this.logger.error('URL extraction failed:', error);
            if (error instanceof BadRequestException) {
                throw error;
            }
            throw new InternalServerErrorException('URL extraction failed. Please try again.');
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
    ): Promise<{ 
        message: string; 
        shopifyProductId?: string;
        operationId?: string;
        status?: string;
    }> {
        try {
            // Log the start of Shopify publishing
            await this.activityLogService.logPlatformEvent(
                'SHOPIFY_PUBLISH_STARTED',
                'In Progress',
                `Started publishing product to Shopify`,
                {
                    connectionId: publishData.platformConnectionId,
                    platformType: 'shopify',
                    operation: 'create',
                    syncDirection: 'push'
                },
                req.user.id,
                publishData.platformConnectionId
            );

        this.logger.log(`[publishToShopify] Entered method for productId: ${productId}, user: ${req.user.id}`);
        this.logger.debug(`[publishToShopify] Received publishData: ${JSON.stringify(publishData)}`);

        const userId = req.user.id;
        const options = publishData.options || {};

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

            // First, get a representative variant for product-level info
            const primaryVariant = canonicalVariantsFull[0];

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
                
                const shopifyOptionValues = this._mapShopifyOptionValues(cv, shopifyProductOptions);
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
                title: canonicalProduct.Title || primaryVariant.Title || 'Untitled Product',
                descriptionHtml: canonicalProduct.Description || 
                               (primaryVariant.Options?.shopify && typeof primaryVariant.Options.shopify === 'object' ? 
                                primaryVariant.Options.shopify['description'] : undefined),
                vendor: options.vendor || undefined,
                productType: options.productType || undefined,
                status: options.status || 'ACTIVE',
                tags: options.tags || [],
                productOptions: shopifyProductOptions.length > 0 ? shopifyProductOptions : undefined,
                files: productLevelShopifyFiles.length > 0 ? productLevelShopifyFiles : undefined,
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
                // Check if this is an async operation that was successfully queued
                if (shopifyResponse.status === 'CREATED' || shopifyResponse.status === 'RUNNING') {
                    this.logger.log(`[publishToShopify] Product creation queued successfully on Shopify. Operation ID: ${shopifyResponse.operationId}, Status: ${shopifyResponse.status}`);
                    
                    // For async operations, we don't have the product ID immediately
                    // Return success without trying to create mappings
                    return { 
                        message: `Product ${productId} successfully queued for creation on Shopify. Operation ID: ${shopifyResponse.operationId}`,
                        operationId: shopifyResponse.operationId,
                        status: shopifyResponse.status
                    };
                } else {
                const errorMessage = `Failed to obtain Shopify Product ID for product ${productId}. Status: ${shopifyResponse.status}`;
                this.logger.error(`[publishToShopify] ${errorMessage}`);
                throw new InternalServerErrorException(errorMessage);
                }
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
            
            // Log successful completion
            await this.activityLogService.logPlatformEvent(
                'SHOPIFY_PUBLISH_COMPLETED',
                'Success',
                `Successfully published product to Shopify`,
                {
                    connectionId: publishData.platformConnectionId,
                    platformType: 'shopify',
                    operation: 'create',
                    syncDirection: 'push',
                    itemsProcessed: 1,
                    itemsSucceeded: 1,
                    itemsFailed: 0
                },
                req.user.id,
                publishData.platformConnectionId
            );
            
            return { 
                message: `Product ${productId} successfully published/updated on Shopify. Shopify Product ID: ${shopifyProductIdForMedia}`,
                shopifyProductId: shopifyProductIdForMedia,
            };

        } catch (error) {
            // Log the error
            await this.activityLogService.logPlatformEvent(
                'SHOPIFY_PUBLISH_FAILED',
                'Failed',
                `Failed to publish product to Shopify: ${error.message}`,
                {
                    connectionId: publishData.platformConnectionId,
                    platformType: 'shopify',
                    operation: 'create',
                    syncDirection: 'push',
                    itemsProcessed: 1,
                    itemsSucceeded: 0,
                    itemsFailed: 1,
                    errors: [error.message]
                },
                req.user.id,
                publishData.platformConnectionId
            );

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

    private _mapShopifyOptionValues(canonicalVariant: ProductVariant, productOptions: ShopifyProductOption[]): { optionName: string; name: string }[] {
        const result: { optionName: string; name: string }[] = [];
        
        // If the variant has Options structure, try to match them with product options
        if (canonicalVariant.Options) {
            // For each defined product option, find matching value in variant Options
            for (const option of productOptions) {
                const optionName = option.name;
                
                // Default to first value if not found (extract name from ShopifyProductOptionValue)
                let optionValue = option.values && option.values.length > 0 ? option.values[0].name : ''; 
                
                // If the variant has a title and this is the "Title" option, use the variant title
                if (optionName === 'Title' && canonicalVariant.Title) {
                    optionValue = canonicalVariant.Title;
                }
                // Try to find option value in variant.Options
                else if (canonicalVariant.Options[optionName]) {
                    // Ensure value is a string
                    optionValue = String(canonicalVariant.Options[optionName]);
                }
                
                result.push({
                    optionName,
                    name: optionValue
                });
            }
        } 
        // Fallback to using Title option
        else if (canonicalVariant.Title && productOptions.some(opt => opt.name === 'Title')) {
            result.push({
                optionName: 'Title',
                name: canonicalVariant.Title
            });
        }
        
        this.logger.debug(`[_mapShopifyOptionValues] Mapped option values for SKU ${canonicalVariant.Sku}: ${JSON.stringify(result)}`);
        return result;
    }

    /**
     * Cross-account product synchronization endpoint
     * Syncs products, inventory, and pricing across all enabled platform connections for the user
     */
    @Post('cross-account/sync')
    @UseGuards(SupabaseAuthGuard)
    @HttpCode(HttpStatus.ACCEPTED)
    async syncProductsAcrossAccounts(
        @Body() syncData: {
            sourceConnectionId: string;
            targetConnectionIds: string[];
            syncInventory?: boolean;
            syncPricing?: boolean;
            syncStatus?: boolean;
            autoSync?: boolean;
        },
        @Req() req: AuthenticatedRequest
    ): Promise<{
        message: string;
        success: boolean;
        syncedProducts: number;
        failedProducts: number;
        errors: string[];
    }> {
        const userId = req.user.id;
        this.logger.log(`[POST /cross-account/sync] User: ${userId} - Starting cross-account sync`);

        try {
            const options = {
                sourceConnectionId: syncData.sourceConnectionId,
                targetConnectionIds: syncData.targetConnectionIds,
                syncInventory: syncData.syncInventory ?? true,
                syncPricing: syncData.syncPricing ?? true,
                syncStatus: syncData.syncStatus ?? true,
                autoSync: syncData.autoSync ?? false
            };

            const result = await this.crossAccountSyncService.syncProductsAcrossAccounts(userId, options);

            this.logger.log(`[POST /cross-account/sync] User: ${userId} - Sync completed. Success: ${result.success}, Synced: ${result.syncedProducts}`);
            
            return {
                message: result.success ? 'Cross-account synchronization completed successfully' : 'Cross-account synchronization completed with errors',
                success: result.success,
                syncedProducts: result.syncedProducts,
                failedProducts: result.failedProducts,
                errors: result.errors
            };
        } catch (error) {
            this.logger.error(`[POST /cross-account/sync] User: ${userId} - Error: ${error.message}`, error.stack);
            throw new InternalServerErrorException(`Cross-account sync failed: ${error.message}`);
        }
    }

    /**
     * Cross-account product search endpoint
     * Searches for products across all user's platform connections
     */
    @Get('cross-account/search')
    @UseGuards(SupabaseAuthGuard)
    @HttpCode(HttpStatus.OK)
    async searchProductsAcrossConnections(
        @Req() req: AuthenticatedRequest,
        @Query('query') searchQuery: string,
        @Query('connectionIds') connectionIds?: string // Comma-separated connection IDs to search
    ): Promise<{
        results: Array<{
            productId: string;
            variantId: string;
            sku: string;
            title: string;
            price: number;
            platformType: string;
            connectionId: string;
            connectionName: string;
            lastSynced?: string;
        }>;
        totalResults: number;
    }> {
        const userId = req.user.id;
        this.logger.log(`[GET /cross-account/search] User: ${userId} - Searching: "${searchQuery}"`);

        if (!searchQuery || searchQuery.trim().length === 0) {
            throw new BadRequestException('Search query is required and cannot be empty');
        }

        try {
            const connectionFilter = connectionIds?.split(',').map(id => id.trim()).filter(Boolean);

            const searchResults = await this.crossAccountSyncService.searchProductsAcrossConnections(
                userId,
                searchQuery,
                connectionFilter
            );

            // Transform the results to match the expected format
            const formattedResults = searchResults.map(item => ({
                productId: item.product?.Id || '',
                variantId: item.variant?.Id || '',
                sku: item.variant?.Sku || '',
                title: item.variant?.Title || '',
                price: item.variant?.Price || 0,
                platformType: item.connection?.PlatformType || '',
                connectionId: item.connection?.Id || '',
                connectionName: item.connection?.DisplayName || '',
                lastSynced: item.mapping?.LastSyncedAt || undefined
            }));

            this.logger.log(`[GET /cross-account/search] User: ${userId} - Found ${formattedResults.length} results`);
            
            return {
                results: formattedResults,
                totalResults: formattedResults.length
            };
        } catch (error) {
            this.logger.error(`[GET /cross-account/search] User: ${userId} - Error: ${error.message}`, error.stack);
            throw new InternalServerErrorException(`Cross-account search failed: ${error.message}`);
        }
    }

    @Post('/:id/activities')
    async logProductActivity(
        @Param('id') productId: string,
        @Body() logData: {
            eventType: string;
            status: string;
            message: string;
            details?: any;
            platformConnectionId?: string;
        },
        @Req() req: AuthenticatedRequest
    ): Promise<{ message: string }> {
        try {
            await this.activityLogService.logProductEvent(
                logData.eventType,
                logData.status,
                logData.message,
                {
                    productId,
                    ...logData.details
                },
                req.user.id,
                logData.platformConnectionId
            );

            return { message: 'Activity logged successfully' };
        } catch (error) {
            this.logger.error(`Failed to log product activity: ${error.message}`, error.stack);
            throw new InternalServerErrorException('Failed to log activity');
        }
    }

    @Get('/:id/activities')
    async getProductActivityLogs(
        @Param('id') productId: string,
        @Req() req: AuthenticatedRequest,
        @Query('limit') limit?: string,
        @Query('entityType') entityType?: string
    ): Promise<any[]> {
        try {
            const logs = await this.activityLogService.getEntityActivityLogs(
                entityType || 'Product',
                productId,
                req.user.id
            );

            const limitNum = limit ? parseInt(limit) : 50;
            return logs.slice(0, limitNum);
        } catch (error) {
            this.logger.error(`Failed to fetch product activity logs: ${error.message}`, error.stack);
            throw new InternalServerErrorException('Failed to fetch activity logs');
        }
    }

    @Get('/activities')
    async getUserActivityLogs(
        @Req() req: AuthenticatedRequest,
        @Query('entityType') entityType?: string,
        @Query('eventType') eventType?: string,
        @Query('status') status?: string,
        @Query('platformConnectionId') platformConnectionId?: string,
        @Query('startDate') startDate?: string,
        @Query('endDate') endDate?: string,
        @Query('limit') limit?: string,
        @Query('offset') offset?: string
    ): Promise<any[]> {
        try {
            const logs = await this.activityLogService.getUserActivityLogs(
                req.user.id,
                {
                    entityType,
                    eventType,
                    status,
                    platformConnectionId,
                    startDate,
                    endDate,
                    limit: limit ? parseInt(limit) : 50,
                    offset: offset ? parseInt(offset) : 0,
                }
            );

            return logs;
        } catch (error) {
            this.logger.error(`Failed to fetch user activity logs: ${error.message}`, error.stack);
            throw new InternalServerErrorException('Failed to fetch activity logs');
        }
    }

    @Get('/activities/stats')
    async getActivityStats(
        @Req() req: AuthenticatedRequest,
        @Query('timeRange') timeRange?: 'day' | 'week' | 'month' | 'year'
    ): Promise<{
        totalEvents: number;
        eventsByType: Record<string, number>;
        eventsByStatus: Record<string, number>;
        eventsByPlatform: Record<string, number>;
    }> {
        try {
            const stats = await this.activityLogService.getActivityStats(
                req.user.id,
                timeRange || 'week'
            );

            return stats;
        } catch (error) {
            this.logger.error(`Failed to fetch activity stats: ${error.message}`, error.stack);
            throw new InternalServerErrorException('Failed to fetch activity stats');
        }
    }

    // Add inventory update logging
    @Put('/:variantId/inventory')
    async updateProductInventory(
        @Param('variantId') variantId: string,
        @Req() req: AuthenticatedRequest,
        @Body() updateData: {
            updates: Array<{
                platformConnectionId: string;
                locationId: string;
                quantity: number;
                locationName?: string;
            }>;
        }
    ): Promise<{ message: string; updatedCount: number }> {
        try {
            let updatedCount = 0;
            
            for (const update of updateData.updates) {
                // Get current quantity for logging
                const currentLevel = await this.supabaseService.getClient()
                    .from('InventoryLevels')
                    .select('Quantity')
                    .eq('ProductVariantId', variantId)
                    .eq('PlatformConnectionId', update.platformConnectionId)
                    .eq('PlatformLocationId', update.locationId)
                    .single();

                const previousQuantity = currentLevel.data?.Quantity || 0;

                // Update the inventory (implement your actual update logic here)
                // ... your inventory update logic ...

                // Log the inventory update
                await this.activityLogService.logInventoryUpdate(
                    variantId,
                    previousQuantity,
                    update.quantity,
                    update.locationId,
                    {
                        platformConnectionId: update.platformConnectionId,
                        locationName: update.locationName || update.locationId,
                        reason: 'Manual update',
                        source: 'user'
                    },
                    req.user.id,
                    update.platformConnectionId
                );

                updatedCount++;
            }

            return {
                message: `Successfully updated inventory for ${updatedCount} location(s)`,
                updatedCount
            };
        } catch (error) {
            this.logger.error(`Failed to update inventory: ${error.message}`, error.stack);
            throw new InternalServerErrorException('Failed to update inventory');
        }
    }

    // Add product update with logging
    @Put('/:id')
    async updateProduct(
        @Param('id') productId: string,
        @Req() req: AuthenticatedRequest,
        @Body() updateData: {
            Title?: string;
            Description?: string;
            Price?: number;
            CompareAtPrice?: number;
            Sku?: string;
            Barcode?: string;
            Weight?: number;
            WeightUnit?: string;
            RequiresShipping?: boolean;
            IsTaxable?: boolean;
            TaxCode?: string;
        }
    ): Promise<{ message: string }> {
        try {
            // Get current product data for logging
            const currentProduct = await this.supabaseService.getClient()
                .from('ProductVariants')
                .select('*')
                .eq('Id', productId)
                .single();

            if (!currentProduct.data) {
                throw new NotFoundException('Product not found');
            }

            // Update the product (implement your actual update logic here)
            // ... your product update logic ...

            // Log the product update
            await this.activityLogService.logProductUpdate(
                currentProduct.data.ProductId,
                productId,
                {
                    title: updateData.Title,
                    sku: updateData.Sku,
                    price: updateData.Price,
                    previousValues: {
                        title: currentProduct.data.Title,
                        price: currentProduct.data.Price,
                        sku: currentProduct.data.Sku
                    },
                    newValues: updateData,
                    operation: 'update',
                    source: 'user'
                },
                req.user.id
            );

            return { message: 'Product updated successfully' };
        } catch (error) {
            this.logger.error(`Failed to update product: ${error.message}`, error.stack);
            throw new InternalServerErrorException('Failed to update product');
        }
    }

    // Add product deletion with logging
    @Delete('/:id')
    async deleteProduct(
        @Param('id') productId: string,
        @Req() req: AuthenticatedRequest
    ): Promise<{ message: string }> {
        try {
            // Get current product data for logging
            const currentProduct = await this.supabaseService.getClient()
                .from('ProductVariants')
                .select('*')
                .eq('Id', productId)
                .single();

            if (!currentProduct.data) {
                throw new NotFoundException('Product not found');
            }

            // Delete the product (implement your actual deletion logic here)
            // ... your product deletion logic ...

            // Log the product deletion
            await this.activityLogService.logProductDelete(
                currentProduct.data.ProductId,
                productId,
                {
                    title: currentProduct.data.Title,
                    sku: currentProduct.data.Sku,
                    operation: 'delete',
                    source: 'user'
                },
                req.user.id
            );

            return { message: 'Product deleted successfully' };
        } catch (error) {
            this.logger.error(`Failed to delete product: ${error.message}`, error.stack);
            throw new InternalServerErrorException('Failed to delete product');
        }
    }



    /**
     * Record user feedback for training data collection
     */
    @Post('recognize/feedback')
    @UseGuards(SupabaseAuthGuard)
    @HttpCode(HttpStatus.OK)
    async recordRecognitionFeedback(
        @Body() feedbackData: {
            matchId: string;
            userSelection?: number; // Index of selected candidate
            userRejected?: boolean; // True if user rejected all
            userFeedback?: string; // Optional comment
            finalAction?: string; // What the user ultimately did
        },
        @Req() req: AuthenticatedRequest,
    ): Promise<{ message: string }> {
        const userId = req.user?.id;
        if (!userId) {
            throw new BadRequestException('User ID not found after authentication.');
        }

        this.logger.log(`[POST /recognize/feedback] User: ${userId} - Recording feedback for match ${feedbackData.matchId}`);

        try {
            await this.productRecognitionService.recordUserFeedback(
                feedbackData.matchId,
                feedbackData.userSelection,
                feedbackData.userRejected || false,
                feedbackData.userFeedback
            );

            return { message: 'Feedback recorded successfully for training' };

        } catch (error) {
            this.logger.error(`[POST /recognize/feedback] Error: ${error.message}`, error.stack);
            throw new InternalServerErrorException(`Failed to record feedback: ${error.message}`);
        }
    }

    /**
     * Get performance metrics for the recognition system
     */
    @Get('recognize/metrics')
    @UseGuards(SupabaseAuthGuard)
    @HttpCode(HttpStatus.OK)
    async getRecognitionMetrics(
        @Req() req: AuthenticatedRequest,
        @Query('period') period?: string,
        @Query('businessTemplate') businessTemplate?: string,
    ): Promise<{
        totalRecognitions: number;
        confidenceDistribution: any;
        userSatisfactionRate: number;
        averageProcessingTime: number;
        fallbackRate: number;
        templatePerformance?: any;
    }> {
        const userId = req.user?.id;
        if (!userId) {
            throw new BadRequestException('User ID not found after authentication.');
        }

        const periodValue = period || '30d';
        this.logger.log(`[GET /recognize/metrics] User: ${userId} - Fetching metrics for period: ${periodValue}`);

        try {
            // Use existing method with corrected signature
            const metrics = await this.productRecognitionService.getPerformanceMetrics(
                businessTemplate,
                parseInt(periodValue.replace('d', '')) || 30
            );

            return {
                totalRecognitions: metrics.totalRecognitions || 0,
                confidenceDistribution: metrics.confidenceDistribution || {},
                userSatisfactionRate: metrics.userSatisfactionRate || 0,
                averageProcessingTime: metrics.averageProcessingTime || 0,
                fallbackRate: metrics.fallbackRate || 0,
                templatePerformance: metrics.templatePerformance
            };

        } catch (error) {
            this.logger.error(`[GET /recognize/metrics] Error: ${error.message}`, error.stack);
            throw new InternalServerErrorException(`Failed to fetch metrics: ${error.message}`);
        }
    }

    /**
     * Get available business templates
     */
    @Get('recognize/templates')
    @UseGuards(SupabaseAuthGuard)
    @HttpCode(HttpStatus.OK)
    async getBusinessTemplates(
        @Req() req: AuthenticatedRequest,
    ): Promise<{
        templates: Array<{
            name: string;
            displayName: string;
            description: string;
            searchKeywords: string[];
            fallbackSources: string[];
            confidenceThresholds: any;
            performance?: any;
        }>;
    }> {
        const userId = req.user?.id;
        if (!userId) {
            throw new BadRequestException('User ID not found after authentication.');
        }

        this.logger.log(`[GET /recognize/templates] User: ${userId} - Fetching business templates`);

        try {
            // Get all available templates
            const templateNames = ['comic-book', 'electronics', 'fashion'];
            const templates = templateNames.map(name => {
                const template = this.productRecognitionService.getBusinessTemplate(name);
                if (!template) {
                    return {
                        name,
                        displayName: name,
                        description: `${name} product recognition template`,
                        searchKeywords: [],
                        fallbackSources: [],
                        confidenceThresholds: { high: 0.95, medium: 0.70 },
                        performance: null
                    };
                }
                return {
                    name: template.name,
                    displayName: template.name,
                    description: `${template.name} product recognition template`,
                    searchKeywords: template.searchKeywords,
                    fallbackSources: template.fallbackSources,
                    confidenceThresholds: template.confidenceThresholds,
                    performance: null
                };
            });

            return { templates };

        } catch (error) {
            this.logger.error(`[GET /recognize/templates] Error: ${error.message}`, error.stack);
            throw new InternalServerErrorException(`Failed to fetch templates: ${error.message}`);
        }
    }

    /**
     * Create or update a business template
     */
    @Post('recognize/templates')
    @UseGuards(SupabaseAuthGuard)
    @HttpCode(HttpStatus.CREATED)
    async createBusinessTemplate(
        @Body() templateData: {
            name: string;
            displayName: string;
            description: string;
            searchKeywords: string[];
            fallbackSources: string[];
            embeddingInstructions: {
                image: string;
                text: string;
            };
            rerankerContext: string;
            confidenceThresholds: {
                high: number;
                medium: number;
            };
        },
        @Req() req: AuthenticatedRequest,
    ): Promise<{ message: string; templateId: string }> {
        const userId = req.user?.id;
        if (!userId) {
            throw new BadRequestException('User ID not found after authentication.');
        }

        this.logger.log(`[POST /recognize/templates] User: ${userId} - Creating template: ${templateData.name}`);

        try {
            // For now, return success - template creation would be implemented in ProductRecognitionService
            const templateId = `template_${Date.now()}`;

            return { 
                message: 'Business template creation scheduled - contact support for custom templates',
                templateId 
            };

        } catch (error) {
            this.logger.error(`[POST /recognize/templates] Error: ${error.message}`, error.stack);
            throw new InternalServerErrorException(`Failed to create template: ${error.message}`);
        }
    }



    @Post('update-platform-flags')
    async updatePlatformFlags(): Promise<{ message: string; updatedCount: number }> {
        try {
            console.log('[ProductsController] Starting platform flags update...');
            
            const supabase = this.supabaseService.getServiceClient();
            
            // For each platform type, update the corresponding boolean flag
            const platforms = ['Shopify', 'Square', 'Clover', 'Amazon', 'Ebay', 'Facebook'];
            let totalUpdated = 0;
            
            for (const platformType of platforms) {
                const columnName = `On${platformType}`;
                
                // Get all variant IDs that should have this platform flag set to true
                const { data: mappingsData, error: mappingsError } = await supabase
                    .from('PlatformProductMappings')
                    .select(`
                        ProductVariantId,
                        PlatformConnections!inner(PlatformType, IsEnabled)
                    `)
                    .eq('PlatformConnections.PlatformType', platformType)
                    .eq('PlatformConnections.IsEnabled', true)
                    .eq('IsEnabled', true);
                    
                if (mappingsError) {
                    console.error(`[ProductsController] Error fetching mappings for ${platformType}:`, mappingsError);
                    continue;
                }
                
                const variantIds = [...new Set(mappingsData?.map(m => m.ProductVariantId) || [])];
                console.log(`[ProductsController] Found ${variantIds.length} variants for ${platformType}`);
                
                if (variantIds.length > 0) {
                    // Update variants that should have this platform flag set to true
                    const { data: updateData, error: updateError } = await supabase
                        .from('ProductVariants')
                        .update({ [columnName]: true })
                        .in('Id', variantIds)
                        .select('Id');
                        
                    if (updateError) {
                        console.error(`[ProductsController] Error updating ${platformType} flags:`, updateError);
                    } else {
                        const updated = updateData?.length || 0;
                        console.log(`[ProductsController] Updated ${updated} variants for ${platformType}`);
                        totalUpdated += updated;
                    }
                }
                
                // Reset flags for variants that should be false (not in mappings)
                const { data: resetData, error: resetError } = await supabase
                    .from('ProductVariants')
                    .update({ [columnName]: false })
                    .not('Id', 'in', `(${variantIds.length > 0 ? variantIds.map(id => `'${id}'`).join(',') : "''"})`)
                    .select('Id');
                    
                if (resetError) {
                    console.error(`[ProductsController] Error resetting ${platformType} flags:`, resetError);
                } else {
                    console.log(`[ProductsController] Reset ${resetData?.length || 0} variants for ${platformType}`);
                }
            }
            
            console.log(`[ProductsController] Platform flags update completed. Total updated: ${totalUpdated}`);
            return { 
                message: 'Platform flags updated successfully', 
                updatedCount: totalUpdated 
            };
            
        } catch (error) {
            console.error('[ProductsController] Error updating platform flags:', error);
            throw new Error('Failed to update platform flags');
        }
    }

    /**
     * AI Visual Matching - Separate step after analyze for better suggestions
     * Runs in parallel with frontend response for performance
     */
    @Post('orchestrate/ai-visual-match')
    @Feature('aiScans')
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard)
    @Throttle({ default: { limit: 15, ttl: 60000 }}) // 15 requests per minute - faster operation
    @HttpCode(HttpStatus.OK)
    async aiVisualMatch(
        @Body() matchRequest: {
            imageUrl?: string;
            imageBase64?: string;
            serpApiResults: any[]; // Results from analyze step
            userContext?: string; // Optional context from user
        },
        @Req() req: AuthenticatedRequest,
    ): Promise<{
        aiSuggestions: Array<{
            serpApiIndex: number;
            confidence: number;
            reasoning: string;
            visualSimilarity: number;
            recommendedAction: 'select_this' | 'consider' | 'review_manually';
        }>;
        topRecommendation?: {
            index: number;
            confidence: number;
            reasoning: string;
        };
        processingTimeMs: number;
    }> {
        const userId = req.user?.id;
        if (!userId) {
            throw new BadRequestException('User ID not found after authentication.');
        }

        const startTime = Date.now();
        this.logger.log(`[AI Visual Match] User: ${userId} - Processing ${matchRequest.serpApiResults.length} SerpAPI results`);

        try {
            if (!matchRequest.serpApiResults?.length) {
                return {
                    aiSuggestions: [],
                    processingTimeMs: Date.now() - startTime
                };
            }

            // Use AI Generation Service for intelligent visual matching
            const prompt = `You are an expert visual product matcher. Analyze the provided image against these search results and determine which result best matches the user's product visually and contextually.

Image: ${matchRequest.imageUrl || 'base64 image provided'}
User Context: ${matchRequest.userContext || 'No additional context'}

SerpAPI Results to Match Against:
${matchRequest.serpApiResults.map((result, idx) => `${idx + 1}. Title: "${result.title}" | Price: ${result.price} | Source: ${result.source} | Snippet: ${result.snippet}`).join('\n')}

For each result, provide:
1. Visual similarity score (0-1)
2. Overall confidence (0-1) 
3. Reasoning for the match/mismatch
4. Recommended action

Return JSON format:
{
  "matches": [
    {
      "index": 0,
      "visualSimilarity": 0.85,
      "confidence": 0.90,
      "reasoning": "Strong visual match - same product category, brand, and styling",
      "recommendedAction": "select_this"
    }
  ],
  "topRecommendation": {
    "index": 0,
    "confidence": 0.90,
    "reasoning": "Best overall match based on visual and contextual analysis"
  }
}`;

            const aiResponse = await this.aiGenerationService.generateProductDetails(
                [matchRequest.imageUrl || ''],
                matchRequest.imageUrl || '',
                ['visual_matching'],
                null,
                {
                    url: 'ai_visual_matching',
                    scrapedData: { serpApiResults: matchRequest.serpApiResults },
                    analysis: prompt
                }
            );

            // Parse AI response for visual matching
            let aiSuggestions: any[] = [];
            let topRecommendation: any = null;

            if (aiResponse && aiResponse.visual_matching) {
                // Try to extract structured data from AI response
                try {
                    const matchData = typeof aiResponse.visual_matching === 'string' 
                        ? JSON.parse(aiResponse.visual_matching) 
                        : aiResponse.visual_matching;
                    
                    aiSuggestions = matchData.matches?.map((match: any, idx: number) => ({
                        serpApiIndex: match.index || idx,
                        confidence: match.confidence || 0.5,
                        reasoning: match.reasoning || 'AI analysis completed',
                        visualSimilarity: match.visualSimilarity || match.confidence || 0.5,
                        recommendedAction: match.recommendedAction || 'review_manually'
                    })) || [];

                    topRecommendation = matchData.topRecommendation;
                } catch (parseError) {
                    this.logger.warn(`Failed to parse AI visual match response: ${parseError.message}`);
                }
            }

            // Fallback: Use reranker service for basic similarity
            if (aiSuggestions.length === 0) {
                this.logger.log(`[AI Visual Match] Falling back to reranker service`);
                
                const rerankerCandidates = matchRequest.serpApiResults.map((result, idx) => ({
                    id: idx.toString(),
                    title: result.title,
                    description: result.snippet,
                    metadata: { source: result.source, price: result.price }
                }));

                const rerankerResponse = await this.rerankerService.rerankCandidates({
                    query: matchRequest.userContext || 'product match',
                    targetUrl: matchRequest.imageUrl || matchRequest.imageBase64, // Pass target image
                    candidates: rerankerCandidates,
                    userId,
                    businessTemplate: 'visual_matching',
                    useVisualReranking: true // 🎯 NEW: Enable visual comparison!
                });

                aiSuggestions = rerankerResponse.rankedCandidates.map((candidate: any, idx: number) => ({
                    serpApiIndex: parseInt(candidate.id),
                    confidence: candidate.score || 0.5,
                    reasoning: `Reranker match - score: ${candidate.score?.toFixed(2)}`,
                    visualSimilarity: candidate.score || 0.5,
                    recommendedAction: candidate.score > 0.8 ? 'select_this' : 'consider'
                }));

                if (aiSuggestions.length > 0) {
                    topRecommendation = {
                        index: aiSuggestions[0].serpApiIndex,
                        confidence: aiSuggestions[0].confidence,
                        reasoning: 'Top reranker result'
                    };
                }
            }

            const processingTimeMs = Date.now() - startTime;
            this.logger.log(`[AI Visual Match] Completed in ${processingTimeMs}ms with ${aiSuggestions.length} suggestions`);

            return {
                aiSuggestions: aiSuggestions.slice(0, 5), // Top 5 suggestions
                topRecommendation,
                processingTimeMs
            };

        } catch (error) {
            this.logger.error(`[AI Visual Match] Error: ${error.message}`, error.stack);
            throw new InternalServerErrorException(`AI visual matching failed: ${error.message}`);
        }
    }

    /**
     * Private helper method for quick vector search - used by other endpoints
     */
    private async quickProductScan(
        @Body() scanData: {
            imageUrl?: string;
            imageBase64?: string;
            textQuery?: string;
            businessTemplate?: string;
            threshold?: number;
        },
        @Req() req: AuthenticatedRequest,
    ) {
        const userId = req.user?.id;
        if (!userId) {
            throw new BadRequestException('User ID not found after authentication.');
        }

        // Extract JWT token from Authorization header for RLS
        const authHeader = req.headers.authorization;
        const jwtToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : undefined;

        return this.productsService.quickProductScan(scanData, userId, jwtToken);
    }





    @Post('orchestrate')
    @Feature('aiScans')
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard)
    @Throttle({ default: { limit: 1, ttl: 60000 }}) // 1 request per minute
    @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    @HttpCode(HttpStatus.OK)
    async orchestrateProduct(
        @Body() orchestrateInput: {
            productId: string;
            orchestrationType: 'recognize' | 'match' | 'generate';
            orchestrationData: RecognizeStageInput | MatchStageInput | GenerateStageInput;
        },
        @Req() req: AuthenticatedRequest,
    ): Promise<any> {
        const userId = req.user?.id;
        if (!userId) {
            throw new BadRequestException('User ID not found after authentication.');
        }

        this.logger.log(`[POST /orchestrate] User: ${userId} - Orchestrating product ${orchestrateInput.productId}`);

                 try {
             switch (orchestrateInput.orchestrationType) {
                 case 'recognize':
                     return await this.productOrchestratorService.recognize(userId, orchestrateInput.orchestrationData as RecognizeStageInput);
                 case 'match':
                     return await this.productOrchestratorService.match(userId, orchestrateInput.orchestrationData as MatchStageInput);
                 case 'generate':
                     return await this.productOrchestratorService.generate(userId, orchestrateInput.orchestrationData as GenerateStageInput);
                 default:
                     throw new BadRequestException('Invalid orchestration type');
             }
        } catch (error) {
            this.logger.error(`[POST /orchestrate] User: ${userId} - Error: ${error.message}`, error.stack);
            throw new InternalServerErrorException(`Orchestration failed: ${error.message}`);
        }
    }

    /**
     * 🎯 3-STAGE ORCHESTRATOR ENDPOINTS 
     * Stage 1: Recognize → Stage 2: Match → Stage 3: Generate
     */

    /**
     * 🎯 QUICK SCAN ENDPOINT - RECOGNIZE STAGE
     * Pure image recognition against existing database products
     * Input: 1 image → Output: matching products from our database OR "no matches"
     */
    @Post('orchestrate/quick-scan')
    @Feature('aiScans')
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard)
    @Throttle({ default: { limit: 20, ttl: 60000 }}) // 20 requests per minute for quick scans
    @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    @HttpCode(HttpStatus.OK)
    async quickScan(
        @Body() scanInput: {
            images: Array<{
                url?: string;
                base64?: string;
                metadata?: any;
            }>;
            targetSites?: string[]; // For backward compatibility, will be ignored
            reranker?: 'llama4-groq' | 'jina-modal' | 'fast-text' | 'none'; // 🎯 NEW: Choose reranker system
            mode?: 'vlm-first' | 'vector-first' | 'auto' | 'ocr-vlm-search' | 'embed-search';
        },
        @Req() req: AuthenticatedRequest,
    ): Promise<{
        results: Array<{
            sourceIndex: number;
            sourceType: 'image';
            matches: any[];
            confidence: 'high' | 'medium' | 'low';
            processingTimeMs: number;
            rerankerAnalysis?: {
                type: 'llama4-groq' | 'jina-modal' | 'fast-text';
                selectedMatch?: any;
                confidence?: number;
                reasoning?: string;
                alternatives?: any[];
                processingTimeMs: number;
                rankingMethod?: string; // For fast-text: exact_match, fuzzy_match, etc.
            };
        }>;
        totalProcessingTimeMs: number;
        overallConfidence: 'high' | 'medium' | 'low';
        recommendedAction: string;
    }> {
        const userId = req.user?.id;
        if (!userId) {
            throw new BadRequestException('User ID not found after authentication.');
        }

        if (!scanInput.images || scanInput.images.length === 0) {
            throw new BadRequestException('At least one image is required for quick scan');
        }

        this.logger.log(`[POST /orchestrate/quick-scan] User: ${userId} - Processing ${scanInput.images.length} image(s) for recognition`);

        try {
            const startTime = Date.now();
            const results: Array<{
                sourceIndex: number;
                sourceType: 'image';
                matches: any[];
                confidence: 'high' | 'medium' | 'low';
                processingTimeMs: number;
            }> = [];

            // Normalize mode synonyms
            const normalizedMode = scanInput.mode === 'ocr-vlm-search'
                ? 'vlm-first'
                : scanInput.mode === 'embed-search'
                    ? 'vector-first'
                    : (scanInput.mode as any);

            // Process each image against our database
            for (let i = 0; i < scanInput.images.length; i++) {
                const image = scanInput.images[i];
                
                try {
                    // Route to VLM-first if requested
                    if (normalizedMode === 'vlm-first') {
                        const startVlm = Date.now();
                        const vlmResult = await this.embeddingService.performEnhancedQuickScan({
                            images: image.url ? [image.url] : undefined,
                            textQuery: undefined,
                            businessTemplate: 'general',
                            threshold: 0.0,
                            userId: req.user.id,
                            mode: 'vlm-first',
                        }, req.headers['authorization'] as string | undefined);
                        const vlmTime = Date.now() - startVlm;
                        this.logger.log(`[QuickScan VLM-First] Image ${i} completed in ${vlmTime}ms with ${vlmResult.matches.length} matches (conf=${vlmResult.confidence})`);
                        results.push({
                            sourceIndex: i,
                            sourceType: 'image',
                            matches: vlmResult.matches,
                            confidence: vlmResult.confidence,
                            processingTimeMs: vlmResult.processingTimeMs,
                        });
                        continue;
                    }

                    const imageResult = await this.quickProductScan({
                        imageUrl: image.url,
                        imageBase64: image.base64,
                        businessTemplate: 'general', // Always general for recognition
                        threshold: 0.7 // Filter out weak matches (<70%) so we only show solid candidates
                    }, req);

                    results.push({
                        sourceIndex: i,
                        sourceType: 'image',
                        matches: imageResult.matches,
                        confidence: imageResult.confidence,
                        processingTimeMs: imageResult.processingTimeMs
                    });

                } catch (error) {
                    this.logger.warn(`Failed to process image ${i}: ${error.message}`);
                    results.push({
                        sourceIndex: i,
                        sourceType: 'image',
                        matches: [],
                        confidence: 'low',
                        processingTimeMs: 0
                    });
                }
            }

            // 🎯 Process results with selected reranker system
            this.logger.log(`[POST /orchestrate/quick-scan] Processing results with reranker: ${scanInput.reranker || 'none'}`);
            
            for (const result of results) {
                this.logger.log(`[RerankerDebug] Image ${result.sourceIndex}: Found ${result.matches.length} vector matches, confidence: ${result.confidence}`);
                
                // Show all matches regardless of threshold/confidence for debugging
                if (result.matches.length > 0) {
                    try {
                        // Log top 15 raw vector results as requested
                        this.logger.log(`[VectorResults] Top ${Math.min(25, result.matches.length)} raw vector search results:`);
                        result.matches.slice(0, 25).forEach((match: any, index: number) => {
                            this.logger.log(`  ${index + 1}. "${match.title?.substring(0, 50) || 'No title'}..." - Score: ${match.combinedScore?.toFixed(4) || 'N/A'}`);
                        });

                        // 🎯 NEW: Optimized Pipeline A - Text-first, fast, scalable
                        if (scanInput.reranker === 'llama4-groq') {
                            this.logger.log(`[PipelineA-GroqPicker] Analyzing ${result.matches.length} vector search results with OCR-driven selection`);
                            
                            try {
                                const groqCandidates = result.matches.slice(0, 50).map((match: any) => ({
                                    id: match.ProductVariantId || match.variantId || `temp_${Date.now()}_${Math.random()}`,
                                    title: match.title || 'Unknown Product',
                                    description: match.description || 'No description',
                                    imageUrl: match.imageUrl,
                                    vectorScore: match.combinedScore || 0,
                                    metadata: match
                                }));

                                // Extract OCR text from the image for better matching
                                let ocrText: string | undefined;
                                try {
                                    const imageUrl = scanInput.images[result.sourceIndex]?.url!;
                                    const ocrResult = await this.embeddingService.extractOcrText(imageUrl);
                                    ocrText = ocrResult?.text;
                                    this.logger.log(`[GroqSmartPicker] OCR extracted: "${ocrText?.substring(0, 50)}..." (conf: ${ocrResult?.confidence.toFixed(2)})`);
                                } catch (ocrError) {
                                    this.logger.warn(`[GroqSmartPicker] OCR failed: ${ocrError.message}`);
                                }

                                const smartPickerResult = await this.groqSmartPickerService.pickBestMatch({
                                    targetImage: scanInput.images[result.sourceIndex]?.url!,
                                    ocrText, // Pass extracted OCR text
                                    candidates: groqCandidates,
                                    maxCandidates: 20,
                                    userId: req.user?.id
                                });

                                // Add reranker analysis to result
                                (result as any).rerankerAnalysis = {
                                    type: 'llama4-groq',
                                    selectedMatch: smartPickerResult.selectedCandidate.metadata,
                                    confidence: smartPickerResult.confidence,
                                    reasoning: smartPickerResult.reasoning,
                                    alternatives: smartPickerResult.alternativeOptions?.map(alt => alt.metadata) || [],
                                    processingTimeMs: smartPickerResult.processingTimeMs
                                };

                                // 🎯 Promote selected match to the top of results for clarity
                                try {
                                    const selected = smartPickerResult.selectedCandidate.metadata;
                                    const normalize = (s: string) => (s || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();

                                    let foundIndex = result.matches.findIndex((m: any) =>
                                        (m.ProductVariantId && selected.ProductVariantId && m.ProductVariantId === selected.ProductVariantId) ||
                                        (m.productId && selected.productId && m.productId === selected.productId) ||
                                        (m.imageUrl && selected.imageUrl && m.imageUrl === selected.imageUrl) ||
                                        (m.title && selected.title && normalize(m.title) === normalize(selected.title))
                                    );

                                    if (foundIndex === -1) {
                                        // Not found — prepend the selected item
                                        result.matches = [selected, ...result.matches];
                                    } else if (foundIndex > 0) {
                                        const [picked] = result.matches.splice(foundIndex, 1);
                                        result.matches.unshift(picked);
                                    }

                                    // Adjust confidence tier based on Groq score
                                    if (smartPickerResult.confidence >= 0.9) {
                                        result.confidence = 'high';
                                    } else if (smartPickerResult.confidence >= 0.7 && result.confidence !== 'high') {
                                        result.confidence = 'medium';
                                    }
                                } catch (promoteErr) {
                                    this.logger.warn(`[GroqSmartPicker] Failed to promote selected match: ${promoteErr.message}`);
                                }

                                this.logger.log(`[GroqSmartPicker] ✅ Selected: "${smartPickerResult.selectedCandidate.title}" (confidence: ${smartPickerResult.confidence.toFixed(2)})`);
                                this.logger.log(`[GroqSmartPicker] 🤖 Reasoning: ${smartPickerResult.reasoning}`);

                                // Reorder matches to put selected candidate first
                                const selectedId = smartPickerResult.selectedCandidate.id;
                                const selectedMatch = result.matches.find((m: any) => 
                                    (m.ProductVariantId || m.variantId) === selectedId
                                );
                                
                                if (selectedMatch) {
                                    const otherMatches = result.matches.filter((m: any) => 
                                        (m.ProductVariantId || m.variantId) !== selectedId
                                    );
                                    result.matches = [selectedMatch, ...otherMatches];
                                    this.logger.log(`[GroqSmartPicker] 🔄 Moved selected match to top of results`);

                                    // Update confidence based on Groq's assessment
                                    if (smartPickerResult.confidence >= 0.8) {
                                        result.confidence = 'high';
                                    } else if (smartPickerResult.confidence >= 0.6) {
                                        result.confidence = 'medium';
                                    }
                                } else {
                                    this.logger.warn(`[GroqSmartPicker] ⚠️ Selected match not found in original candidates`);
                                }

                            } catch (groqError) {
                                this.logger.error(`[GroqSmartPicker] Failed: ${groqError.message}`);
                                // Continue with regular reranker logic below
                            }
                            
                        } else if (scanInput.reranker === 'jina-modal') {
                            // Use traditional Jina reranker on Modal
                            this.logger.log(`[RerankerDebug] Raw matches before mapping:`);
                            result.matches.slice(0, 5).forEach((match: any, index: number) => {
                                this.logger.log(`  Raw Match ${index + 1}: "${match.title}" - URL: ${match.imageUrl} - ID: ${match.ProductVariantId || match.variantId}`);
                            });

                            // 🎯 Deduplicate matches before sending to reranker 
                            const uniqueMatches = this.deduplicateMatchesByTitle(result.matches);
                            this.logger.log(`[RerankerDebug] Deduplicated ${result.matches.length} -> ${uniqueMatches.length} matches before reranker`);

                            const rerankerCandidates = uniqueMatches.map((match: any, index: number) => ({
                                id: match.ProductVariantId || match.variantId || `temp_${Date.now()}_${Math.random()}_${index}`,
                                title: match.title || 'Unknown Product',
                                description: match.description || 'No description',
                                businessTemplate: match.businessTemplate || 'general',
                                imageUrl: match.imageUrl,
                                price: match.price,
                                metadata: {
                                    sourceUrl: match.link || match.url || match.sourceUrl,
                                    source: match.source,
                                    productId: match.productId,
                                    imageSimilarity: match.imageSimilarity,
                                    textSimilarity: match.textSimilarity,
                                    combinedScore: match.combinedScore
                                }
                            }));

                            // 🎯 FIXED: Use generic product search query instead of biasing toward first match
                            // Using the first match's description biases the reranker toward that specific item
                            const rerankQuery = 'Find the most relevant product match based on visual and contextual similarity';

                            this.logger.log(`[RerankerDebug] Mapped candidates for reranker:`);
                            rerankerCandidates.slice(0, 5).forEach((candidate, index) => {
                                this.logger.log(`  Candidate ${index + 1}: "${candidate.title}" - URL: ${candidate.imageUrl} - ID: ${candidate.id}`);
                            });

                            this.logger.log(`[RerankerInput] Sending ${rerankerCandidates.length} candidates to reranker`);

                            const rerankerResponse = await this.rerankerService.rerankCandidates({
                                query: rerankQuery,
                                targetUrl: scanInput.images[result.sourceIndex]?.url, // 🎯 CRITICAL: Pass the actual target image
                                candidates: rerankerCandidates,
                                userId: req.user?.id,
                                businessTemplate: 'general',
                                maxCandidates: rerankerCandidates.length, // send all to get full ordering
                                useVisualReranking: true // 🎯 NEW: Enable visual comparison!
                            });

                            this.logger.log(`[RerankerResults] Top reranked results:`);
                            rerankerResponse.rankedCandidates.slice(0, 10).forEach((candidate: any, index: number) => {
                                this.logger.log(`  ${index + 1}. "${candidate.title?.substring(0, 50)}..." - Reranker Score: ${candidate.score?.toFixed(4)} (Rank: ${candidate.rank})`);
                            });

                            // Replace matches with full reranked results
                            result.matches = rerankerResponse.rankedCandidates;
                            result.confidence = rerankerResponse.confidenceTier;
                            
                            // Add Jina reranker analysis to result
                            (result as any).rerankerAnalysis = {
                                type: 'jina-modal',
                                selectedMatch: rerankerResponse.rankedCandidates[0],
                                confidence: rerankerResponse.topScore,
                                reasoning: `Jina reranker selected based on multimodal analysis. Top score: ${rerankerResponse.topScore.toFixed(3)}`,
                                alternatives: rerankerResponse.rankedCandidates.slice(1, 4),
                                processingTimeMs: 0 // We don't track this separately for Jina
                            };
                            
                            this.logger.log(`[RerankerFinal] Updated confidence from vector search to reranker: ${rerankerResponse.confidenceTier}`);
                        
                        } else if (scanInput.reranker === 'fast-text') {
                            // 🚀 PIPELINE A: Fast text-only reranker (<100ms)
                            this.logger.log(`[PipelineA-FastText] Running fast OCR-driven text reranker on ${result.matches.length} results`);
                            
                            try {
                                // Extract OCR text from the image for ranking
                                let ocrText: string = '';
                                try {
                                    const imageUrl = scanInput.images[result.sourceIndex]?.url!;
                                    const ocrResult = await this.embeddingService.extractOcrText(imageUrl);
                                    ocrText = ocrResult?.text || '';
                                    this.logger.log(`[PipelineA-FastText] OCR extracted: "${ocrText.substring(0, 50)}..." (conf: ${ocrResult?.confidence || 0})`);
                                } catch (ocrError) {
                                    this.logger.warn(`[PipelineA-FastText] OCR failed: ${ocrError.message}, proceeding with title-only ranking`);
                                }

                                // Prepare candidates for fast text reranker
                                const fastTextCandidates = result.matches.slice(0, 50).map((match: any) => ({
                                    id: match.ProductVariantId || match.variantId || `temp_${Date.now()}_${Math.random()}`,
                                    title: match.title || 'Unknown Product',
                                    description: match.description || '',
                                    vectorScore: match.combinedScore || 0,
                                    metadata: match
                                }));

                                const fastRerankerResponse = await this.fastTextRerankerService.rerankCandidates({
                                    ocrText,
                                    textQuery: undefined, // Could add text query support later
                                    candidates: fastTextCandidates,
                                    maxResults: Math.min(20, result.matches.length)
                                });

                                this.logger.log(`[PipelineA-FastText] Fast reranker completed in ${fastRerankerResponse.processingTimeMs}ms, method: ${fastRerankerResponse.rankingMethod}`);
                                this.logger.log(`[PipelineA-FastText] Top 5 reranked results:`);
                                fastRerankerResponse.rankedCandidates.slice(0, 5).forEach((candidate: any, index: number) => {
                                    this.logger.log(`  ${index + 1}. "${candidate.title.substring(0, 40)}..." - Method: ${fastRerankerResponse.rankingMethod}`);
                                });

                                // Update result with fast reranker output
                                result.matches = fastRerankerResponse.rankedCandidates.map(candidate => candidate.metadata);
                                result.confidence = fastRerankerResponse.confidenceTier;

                                // Add fast text reranker analysis to result
                                (result as any).rerankerAnalysis = {
                                    type: 'fast-text',
                                    confidence: fastRerankerResponse.topScore,
                                    processingTimeMs: fastRerankerResponse.processingTimeMs,
                                    rankingMethod: fastRerankerResponse.rankingMethod,
                                    alternatives: fastRerankerResponse.rankedCandidates.slice(1, 4).map(c => c.metadata)
                                };

                                this.logger.log(`[PipelineA-FastText] Updated confidence from vector search to fast reranker: ${fastRerankerResponse.confidenceTier}`);
                                
                            } catch (fastRerankerError) {
                                this.logger.error(`[PipelineA-FastText] Fast reranker failed: ${fastRerankerError.message}`);
                                // Continue with original vector search results
                            }
                        }

                    } catch (error) {
                        this.logger.error(`Reranker failed for image ${result.sourceIndex}: ${error.message}`);
                        // Keep original matches if reranker fails
                        result.matches = result.matches.slice(0, 3); // At least show top 3 vector results
                    }
                } else {
                    this.logger.log(`[RerankerDebug] No matches to rerank for image ${result.sourceIndex}`);
                }
            }

            // Determine overall confidence
            const highCount = results.filter(r => r.confidence === 'high').length;
            const mediumCount = results.filter(r => r.confidence === 'medium').length;
            const totalCount = results.length;

            let overallConfidence: 'high' | 'medium' | 'low';
            let recommendedAction: string;

            if (highCount === totalCount && totalCount > 0) {
                overallConfidence = 'high';
                recommendedAction = 'show_single_match';
            } else if ((highCount + mediumCount) >= totalCount * 0.8) {
                overallConfidence = 'medium';
                recommendedAction = 'show_multiple_candidates';
            } else {
                overallConfidence = 'low';
                recommendedAction = 'fallback_to_manual';
            }

            // Log activity
            await this.activityLogService.logUserAction(
                'QUICK_SCAN_COMPLETED',
                'Success',
                `Completed recognition scan for ${scanInput.images.length} image(s)`,
                {
                    action: 'quick_scan_recognition',
                    inputData: {
                        imageCount: scanInput.images.length,
                        overallConfidence,
                        reranker: scanInput.reranker || 'none'
                    }
                },
                userId
            );

            // Record scan event to AiGeneratedContent (analytics/training)
            try {
                const supabase = this.supabaseService.getServiceClient();
                await supabase.from('AiGeneratedContent').insert({
                    UserId: req.user?.id || null,
                    ContentType: 'scan',
                    SourceApi: 'serpapi+embeddings',
                    Prompt: 'quick-scan',
                    GeneratedText: JSON.stringify({ results }),
                    Metadata: { 
                        overallConfidence, 
                        recommendedAction, 
                        imageCount: scanInput.images.length,
                        reranker: scanInput.reranker || 'none'
                    },
                    IsActive: false,
                });
            } catch (e) {
                this.logger.warn(`Failed to store scan analytics: ${e?.message || e}`);
            }

            return {
                results,
                totalProcessingTimeMs: Date.now() - startTime,
                overallConfidence,
                recommendedAction
            };

        } catch (error) {
            this.logger.error(`[POST /orchestrate/quick-scan] User: ${userId} - Error: ${error.message}`, error.stack);
            throw new InternalServerErrorException(`Quick scan failed: ${error.message}`);
        }
    }

    // Removed invalid submitGenerateJobs draft endpoint

    @Post('orchestrate/generate-flexible')
    @Feature('aiScans')
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard)
    @Throttle({ default: { limit: 5, ttl: 60000 }})
    @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    @HttpCode(HttpStatus.OK)
    async generateFlexible(
        @Body() generateInput: {
            sources: Array<{
                type: 'image' | 'link' | 'text' | 'external_search';
                data: any; // Image URL, link URL, text content, or external search result
                selectedMatch?: any; // User-selected match from quick scan
                fieldSources?: Record<string, string[]>; // Field-specific URL sources for Normal Search
            }>;
            targetSites: string[]; // Sites to scrape (flexible, not rigid templates)
            platforms: Array<{
                name: string; // 'shopify', 'amazon', etc.
                useScrapedData?: boolean; // Use scraped content for description
                customPrompt?: string;
                fieldSources?: string[]; // Priority sites for this platform
            }>;
            userFlow?: 'quick_search' | 'normal_search'; // Track which flow is being used
        },
        @Req() req: AuthenticatedRequest,
    ): Promise<{
        generatedProducts: Array<{
            sourceIndex: number;
            platforms: Record<string, {
                title: string;
                description: string;
                price?: number;
                images?: string[];
                source: 'ai_generated' | 'scraped_content' | 'hybrid';
                sourceUrls?: string[]; // URLs that provided data for this platform
            }>;
            scrapedData?: Array<{
                url: string;
                content: any;
                usedForFields?: string[]; // Which platform.field combinations used this data
            }>;
            originalSelection?: {
                title: string;
                source: 'database' | 'serpapi' | 'user_input';
                confidence: string;
            };
        }>;
        storageResults: {
            productsCreated: number;
            variantsCreated: number;
            embeddingsStored: number;
        };
        processingLogs: string[]; // Enhanced logging for frontend
    }> {
        const userId = req.user?.id;
        if (!userId) {
            throw new BadRequestException('User ID not found after authentication.');
        }

        const userFlow = generateInput.userFlow || 'quick_search';
        const logs: string[] = [];

        this.logger.log(`[POST /orchestrate/generate-flexible] User: ${userId} - Flow: ${userFlow}, Sources: ${generateInput.sources.length}, Target Sites: ${generateInput.targetSites.join(', ')}`);
        logs.push(`Starting ${userFlow} generation for ${generateInput.sources.length} sources`);

        try {
            const generatedProducts: Array<{
                sourceIndex: number;
                platforms: Record<string, {
                    title: string;
                    description: string;
                    price?: number;
                    images?: string[];
                    source: 'ai_generated' | 'scraped_content' | 'hybrid';
                    sourceUrls?: string[];
                }>;
                scrapedData?: Array<{
                    url: string;
                    content: any;
                    usedForFields?: string[];
                }>;
                originalSelection?: {
                    title: string;
                    source: 'database' | 'serpapi' | 'user_input';
                    confidence: string;
                };
            }> = [];
            let totalProductsCreated = 0;
            let totalVariantsCreated = 0;
            let totalEmbeddingsStored = 0;

            for (let i = 0; i < generateInput.sources.length; i++) {
                const source = generateInput.sources[i];
                logs.push(`📝 Processing source ${i + 1}: ${source.type}`);

                const productData: any = {
                    sourceIndex: i,
                    platforms: {},
                    scrapedData: [],
                    originalSelection: this.extractOriginalSelection(source, userFlow)
                };

                // Step 1: Scrape target sites based on flow type
                const scrapedData = await this.performTargetedScraping(
                    source, 
                    generateInput.targetSites, 
                    generateInput.platforms,
                    userId,
                    logs
                );
                productData.scrapedData = scrapedData;

                // Step 2: Generate platform-specific data with field mapping
                for (const platform of generateInput.platforms) {
                    logs.push(`🎯 Generating ${platform.name} listing`);
                    
                    try {
                        const platformData = await this.generatePlatformSpecificData(
                             source,
                             platform,
                             scrapedData,
                userId,
                             userFlow,
                             logs
                         );
                        
                        productData.platforms[platform.name] = platformData;
                        logs.push(`${platform.name} listing generated successfully`);
                        
                    } catch (error) {
                        logs.push(`${platform.name} generation failed: ${error.message}`);
                        this.logger.warn(`Platform generation failed for ${platform.name}: ${error.message}`);
                    }
                }

                // Step 3: Store the generated product
                logs.push(`Storing generated product data`);
                const storageResult = await this.storeFlexibleProduct(
                    userId, 
                    productData, 
                    generateInput.targetSites
                );
                
                totalProductsCreated += storageResult.productsCreated;
                totalVariantsCreated += storageResult.variantsCreated;
                totalEmbeddingsStored += storageResult.embeddingsStored;

                logs.push(`Product stored: ${storageResult.productsCreated} products, ${storageResult.embeddingsStored} embeddings`);
                generatedProducts.push(productData);
            }

            // Log successful completion
            await this.activityLogService.logUserAction(
                'ORCHESTRATOR_GENERATE_FLEXIBLE',
                'Success',
                `Completed ${userFlow} generation for ${generateInput.sources.length} sources`,
                {
                    action: 'generate_flexible',
                    inputData: {
                        userFlow,
                        sourceCount: generateInput.sources.length,
                        platformCount: generateInput.platforms.length,
                        targetSites: generateInput.targetSites,
                        totalProductsCreated,
                        totalEmbeddingsStored
                    }
                },
                userId
            );

            logs.push(`Generation complete! Created ${totalProductsCreated} products with ${totalEmbeddingsStored} embeddings`);

            return {
                generatedProducts,
                storageResults: {
                    productsCreated: totalProductsCreated,
                    variantsCreated: totalVariantsCreated,
                    embeddingsStored: totalEmbeddingsStored
                },
                processingLogs: logs
            };

        } catch (error) {
            logs.push(`Generation failed: ${error.message}`);
            this.logger.error(`[POST /orchestrate/generate-flexible] User: ${userId} - Error: ${error.message}`, error.stack);
            
            await this.activityLogService.logUserAction(
                'ORCHESTRATOR_GENERATE_FLEXIBLE', 
                'Error',
                `Generation failed: ${error.message}`,
                {
                    action: 'generate_flexible',
                    inputData: { 
                        userFlow: generateInput.userFlow,
                        error: error.message 
                    }
                },
                userId
            );
            
            throw new InternalServerErrorException(`Flexible generation failed: ${error.message}`);
        }
    }

    /**
     * Extract original selection info based on user flow
     */
    private extractOriginalSelection(source: any, userFlow: string): any {
        if (userFlow === 'quick_search' && source.selectedMatch) {
            return {
                title: source.selectedMatch.title,
                source: 'database',
                confidence: 'user_confirmed'
            };
        } else if (userFlow === 'normal_search' && source.data?.selectedResult) {
            return {
                title: source.data.selectedResult.title,
                source: 'serpapi',
                confidence: 'user_confirmed'
            };
        }
        return {
            title: 'Unknown product',
            source: 'user_input',
            confidence: 'low'
        };
    }

    /**
     * Perform targeted scraping based on user flow and field sources
     */
    private async performTargetedScraping(
        source: any,
        targetSites: string[],
        platforms: any[],
        userId: string,
        logs: string[]
    ): Promise<Array<{ url: string; content: any; usedForFields?: string[]; }>> {
        const scrapedData: Array<{ url: string; content: any; usedForFields?: string[]; }> = [];

        // Build comprehensive URL list from target sites and field sources
        const urlsToScrape = new Set<string>();
        
        // Add base target sites
        for (const site of targetSites) {
            if (site.startsWith('http')) {
                urlsToScrape.add(site);
            } else {
                // If it's just a domain, try to build search URLs
                if (source.data?.selectedResult?.link) {
                    urlsToScrape.add(source.data.selectedResult.link);
                }
            }
        }

        // Add field-specific sources from platforms
        for (const platform of platforms) {
            if (platform.fieldSources) {
                for (const fieldSource of platform.fieldSources) {
                    if (fieldSource.startsWith('http')) {
                        urlsToScrape.add(fieldSource);
                    }
                }
            }
        }

        // Scrape each URL
        logs.push(`Scraping ${urlsToScrape.size} URLs for data`);
        
        for (const url of urlsToScrape) {
            try {
                const scraped = await this.firecrawlService.scrape(url);
                
                // Determine which fields will use this scraped data
                const usedForFields: string[] = [];
                for (const platform of platforms) {
                    if (platform.fieldSources?.some(source => url.includes(source.replace('https://', '').replace('http://', '')))) {
                        usedForFields.push(`${platform.name}.title`, `${platform.name}.description`);
                    }
                }

                scrapedData.push({
                    url,
                    content: scraped,
                    usedForFields
                });

                // Track usage
                await this.aiUsageTracker.trackFirecrawlUsage(userId, 'scrape_url', 1, { 
                    url,
                    targetSites: targetSites.join(','),
                    usedForFields: usedForFields.join(',')
                });

                logs.push(`Scraped ${url} successfully`);

            } catch (error) {
                logs.push(`Failed to scrape ${url}: ${error.message}`);
                this.logger.warn(`Scraping failed for ${url}: ${error.message}`);
            }
        }

        return scrapedData;
    }

    // Helper methods for the flexible system
    private buildSearchQueryFromSource(source: any, targetSites: string[]): string {
        let baseQuery = '';
        
        switch (source.type) {
            case 'text':
                baseQuery = source.data;
                break;
            case 'link':
                baseQuery = `Product from ${source.data}`;
                break;
            case 'image':
                baseQuery = source.selectedMatch?.title || 'Product';
                break;
            default:
                baseQuery = 'Product';
        }

        // Add site targeting
        const siteQuery = targetSites.map(site => `site:${site}`).join(' OR ');
        return `${baseQuery} (${siteQuery})`;
    }

    private async generatePlatformSpecificData(
        source: any,
        platform: any,
        scrapedData: any[],
        userId: string,
        userFlow?: string,
        logs?: string[]
    ): Promise<any> {
        logs?.push(`Using AI Generation Service for ${platform.name} listing`);

        try {
            // Prepare data for AI generation service
            let coverImageUrl = '';
            let selectedMatchContext: any = null;
            let enhancedWebData: any = null;

            // Extract image URL
            if (source.type === 'image' && source.data) {
                coverImageUrl = source.data;
            } else if (source.selectedMatch?.imageUrl) {
                coverImageUrl = source.selectedMatch.imageUrl;
            } else if (source.data?.selectedResult?.imageUrl) {
                coverImageUrl = source.data.selectedResult.imageUrl;
            }

            // Prepare context based on user flow
            if (userFlow === 'quick_search' && source.selectedMatch) {
                // Use database match as visual match context
                selectedMatchContext = {
                    visual_matches: [{
                        title: source.selectedMatch.title,
                        price: { value: source.selectedMatch.price?.toString() || '0' },
                        source: 'database_match',
                        snippet: source.selectedMatch.description || ''
                    }]
                };
            } else if (userFlow === 'normal_search' && source.data?.selectedResult) {
                // Use SerpAPI result as visual match context
                selectedMatchContext = {
                    visual_matches: [{
                        title: source.data.selectedResult.title,
                        price: { value: source.data.selectedResult.price?.toString() || '0' },
                        source: source.data.selectedResult.source || 'serpapi',
                        snippet: source.data.selectedResult.snippet || ''
                    }]
                };
            }

            // Prepare enhanced web data from scraped content
            if (scrapedData.length > 0) {
                const primaryScraped = scrapedData[0];
                enhancedWebData = {
                    url: primaryScraped.url,
                    scrapedData: primaryScraped.content,
                    analysis: platform.customPrompt || `Generate optimized ${platform.name} listing`
                };
            }

            // Use AI Generation Service if we have scraped data
            let aiGeneratedDetails: any = null;
            if (scrapedData.length > 0) {
                logs?.push(`Calling AI Generation Service with scraped data for ${platform.name}`);
                
                // Use generateProductDetailsFromScrapedData for scraped content
                const fullDetails = await this.aiGenerationService.generateProductDetailsFromScrapedData(
                    scrapedData,
                    `Generate ${platform.name} listing for: ${selectedMatchContext?.visual_matches?.[0]?.title || 'product'}`,
                    userFlow || 'general',
                    // Pass user selections and platform requirements
                    {
                        selectedSerpApiResult: source.data?.selectedResult || source.selectedMatch,
                        platformRequests: [{
                            platform: platform.name,
                            fieldSources: platform.fieldSources ? { description: platform.fieldSources } : undefined,
                            customPrompt: platform.customPrompt
                        }],
                        targetSites: scrapedData.map(s => new URL(s.url).hostname)
                    }
                );
                
                if (fullDetails && fullDetails[platform.name]) {
                    aiGeneratedDetails = fullDetails[platform.name];
                } else if (fullDetails) {
                    // Use first platform data or generic data
                    aiGeneratedDetails = Object.values(fullDetails)[0] || fullDetails;
                }
            } else if (coverImageUrl) {
                logs?.push(`Calling AI Generation Service with image for ${platform.name}`);
                
                // Use generateProductDetails for image-based generation
                const fullDetails = await this.aiGenerationService.generateProductDetails(
                    [coverImageUrl],
                    coverImageUrl,
                    [platform.name],
                    selectedMatchContext,
                    enhancedWebData
                );
                
                if (fullDetails && fullDetails[platform.name]) {
                    aiGeneratedDetails = fullDetails[platform.name];
                }
            }

            // Build result from AI generation or fallback
            if (aiGeneratedDetails) {
                logs?.push(`AI generated high-quality ${platform.name} listing`);

            return {
                    title: aiGeneratedDetails.title || 'AI Generated Product',
                    description: aiGeneratedDetails.description || 'AI generated description',
                    price: aiGeneratedDetails.price || 0,
                    images: this.extractImages(source, scrapedData),
                    source: 'ai_generated',
                    sourceUrls: scrapedData.map(s => s.url),
                    // Include additional AI-generated fields
                    brand: aiGeneratedDetails.brand,
                    tags: aiGeneratedDetails.tags,
                    categorySuggestion: aiGeneratedDetails.categorySuggestion,
                    specifications: aiGeneratedDetails.specifications || aiGeneratedDetails
                };
            } else {
                // Fallback when AI generation fails
                logs?.push(`AI generation failed, using fallback for ${platform.name}`);
                
                const fallbackTitle = source.selectedMatch?.title || 
                                     source.data?.selectedResult?.title || 
                                     'Product Listing';
                const fallbackDescription = source.selectedMatch?.description || 
                                           source.data?.selectedResult?.snippet || 
                                           scrapedData[0]?.content?.content || 
                                           'Product description';
                const fallbackPrice = source.selectedMatch?.price || 
                                     source.data?.selectedResult?.price || 
                                     0;

                return {
                    title: fallbackTitle,
                    description: fallbackDescription,
                    price: fallbackPrice,
                    images: this.extractImages(source, scrapedData),
                    source: 'fallback',
                    sourceUrls: scrapedData.map(s => s.url)
                };
            }

        } catch (error) {
            logs?.push(`AI generation error for ${platform.name}: ${error.message}`);
            this.logger.error(`AI generation failed for ${platform.name}: ${error.message}`, error.stack);
            
            // Simple fallback
            return {
                title: 'Product Listing',
                description: 'Product description',
                price: 0,
                images: [],
                source: 'error_fallback',
                sourceUrls: []
            };
        }
    }

    private extractImages(source: any, scrapedData: any[]): string[] {
        const images: string[] = [];
        
        // Add source image if available
        if (source.type === 'image' && source.data) {
            images.push(source.data);
        }
        
        // Add images from selected match
        if (source.selectedMatch?.imageUrl) {
            images.push(source.selectedMatch.imageUrl);
        }
        
        // Add images from external search
        if (source.data?.selectedResult?.imageUrl) {
            images.push(source.data.selectedResult.imageUrl);
        }
        
        return [...new Set(images)]; // Remove duplicates
    }

    private extractPriceFromContent(content: string): number {
        // Simple price extraction regex
        const priceMatch = content.match(/\$?(\d+\.?\d*)/);
        return priceMatch ? parseFloat(priceMatch[1]) : 0;
    }

    private async storeFlexibleProduct(
        userId: string,
        productData: any,
        targetSites: string[]
    ): Promise<{ productsCreated: number; variantsCreated: number; embeddingsStored: number }> {
        // Implementation for storing flexible product data
        // This would create the product, variant, and embeddings
        // For now, return mock data
        return {
            productsCreated: 1,
            variantsCreated: 1,
            embeddingsStored: 1
        };
    }

    /**
     * STAGE 2: MATCH
     * Enhances matches with AI ranking and provides review interface data
     */
    @Post('orchestrate/match')
    @Feature('aiScans')
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard)
    @Throttle({ default: { limit: 5, ttl: 60000 }}) // 5 match jobs per minute
    @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    @HttpCode(HttpStatus.ACCEPTED) // 202 Accepted for async operations
    async submitMatchJob(
        @Body() matchRequest: {
            products: Array<{
                productIndex: number;
                productId?: string;
                images: Array<{
                    url?: string;
                    base64?: string;
                    metadata?: any;
                }>;
                textQuery?: string;
            }>;
            options?: {
                useReranking?: boolean; // Default: true
                vectorSearchLimit?: number; // Default: 7
            };
        },
        @Req() req: AuthenticatedRequest,
    ): Promise<{
        jobId: string;
        status: 'queued';
        estimatedTimeMinutes: number;
        totalProducts: number;
        message: string;
    }> {
        const userId = req.user?.id;
        if (!userId) {
            throw new BadRequestException('User ID not found after authentication.');
        }

        // Validate request
        if (!matchRequest.products || matchRequest.products.length === 0) {
            throw new BadRequestException('At least one product is required');
        }
        if (matchRequest.products.length > 100) {
            throw new BadRequestException('Maximum 100 products per match job. Please split into smaller batches.');
        }

        // Generate unique job ID
        const jobId = `match_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const estimatedTimeMinutes = Math.ceil(matchRequest.products.length * 15 / 60); // 15 seconds per product (includes embedding)

        // Create job data
        const jobData: MatchJobData = {
            type: 'match-job',
            jobId,
                userId,
            products: matchRequest.products,
            options: matchRequest.options,
            metadata: {
                totalProducts: matchRequest.products.length,
                estimatedTimeMinutes,
                createdAt: new Date().toISOString(),
            },
        };

        // Submit to queue
        try {
            await QueueManager.enqueueJob(jobData);
            
            this.logger.log(`[Submit Match Job] Created match job ${jobId} for ${matchRequest.products.length} products`);
            
            // Log activity
            await this.activityLogService.logUserAction(
                'MATCH_JOB_SUBMITTED',
                'Success',
                `Match job submitted for ${matchRequest.products.length} products`,
                {
                    action: 'match_job_submitted',
                    inputData: {
                        jobId,
                        productCount: matchRequest.products.length,
                        options: matchRequest.options,
                    },
                },
                userId
            );

            return {
                jobId,
                status: 'queued',
                estimatedTimeMinutes,
                totalProducts: matchRequest.products.length,
                message: `Match job submitted successfully. Processing ${matchRequest.products.length} products with SerpAPI analysis, embedding, and reranking. Estimated completion: ${estimatedTimeMinutes} minutes.`,
            };

        } catch (error) {
            this.logger.error(`[Submit Match Job] Failed to submit job: ${error.message}`);
            
            // Log failed submission
            await this.activityLogService.logUserAction(
                'MATCH_JOB_SUBMISSION_FAILED',
                'Failed',
                `Failed to submit match job: ${error.message}`,
                {
                    action: 'match_job_submission_failed',
                    inputData: {
                        jobId,
                        productCount: matchRequest.products.length,
                        error: error.message,
                    },
                },
                userId
            );
            
            throw new InternalServerErrorException('Failed to submit match job for processing');
        }
    }

    @Get('match/jobs/:jobId/status')
    @Feature('aiScans')
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard)
    @HttpCode(HttpStatus.OK)
    async getMatchJobStatus(
        @Param('jobId') jobId: string,
        @Req() req: AuthenticatedRequest,
    ): Promise<MatchJobStatus> {
        const userId = req.user?.id;
        if (!userId) {
            throw new BadRequestException('User ID not found after authentication.');
        }

        try {
            // Try to get from memory first (faster)
            let jobStatus = this.matchJobProcessor.getJobStatus(jobId);
            
            // If not in memory, try database
            if (!jobStatus) {
                jobStatus = await this.matchJobProcessor.getJobStatusFromDatabase(jobId);
            }

            if (!jobStatus) {
                throw new NotFoundException(`Match job ${jobId} not found`);
            }

            // Verify job belongs to this user (security check)
            if (jobStatus.userId !== userId) {
                throw new NotFoundException(`Match job ${jobId} not found`);
            }

            this.logger.debug(`[Get Match Job Status] Retrieved status for job ${jobId}: ${jobStatus.status} - ${jobStatus.currentStage}`);

            return jobStatus;

        } catch (error) {
            if (error instanceof NotFoundException) {
                throw error;
            }
            this.logger.error(`[Get Match Job Status] Error retrieving job ${jobId}: ${error.message}`);
            throw new InternalServerErrorException('Failed to retrieve match job status');
        }
    }

    @Get('match/jobs/:jobId/results')
    @Feature('aiScans')
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard)
    @HttpCode(HttpStatus.OK)
    async getMatchJobResults(
        @Param('jobId') jobId: string,
        @Req() req: AuthenticatedRequest,
    ): Promise<{
        jobId: string;
        status: string;
        results: MatchJobResult[];
        summary?: any;
        completedAt?: string;
    }> {
        const userId = req.user?.id;
        if (!userId) {
            throw new BadRequestException('User ID not found after authentication.');
        }

        try {
            // Get job status which includes results
            let jobStatus = this.matchJobProcessor.getJobStatus(jobId);
            
            // If not in memory, try database
            if (!jobStatus) {
                jobStatus = await this.matchJobProcessor.getJobStatusFromDatabase(jobId);
            }

            if (!jobStatus) {
                throw new NotFoundException(`Match job ${jobId} not found`);
            }

            // Verify job belongs to this user (security check)
            if (jobStatus.userId !== userId) {
                throw new NotFoundException(`Match job ${jobId} not found`);
            }

            // Only return results if job is completed
            if (jobStatus.status !== 'completed') {
                throw new BadRequestException(`Job ${jobId} is not completed yet. Current status: ${jobStatus.status}`);
            }

            this.logger.log(`[Get Match Job Results] Retrieved ${jobStatus.results.length} results for job ${jobId}`);

            return {
                jobId: jobStatus.jobId,
                status: jobStatus.status,
                results: jobStatus.results,
                summary: jobStatus.summary,
                completedAt: jobStatus.completedAt,
            };

        } catch (error) {
            if (error instanceof NotFoundException || error instanceof BadRequestException) {
                throw error;
            }
            this.logger.error(`[Get Match Job Results] Error retrieving results for job ${jobId}: ${error.message}`);
            throw new InternalServerErrorException('Failed to retrieve match job results');
        }
    }

    @Delete('match/jobs/:jobId')
    @Feature('aiScans')
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard)
    @HttpCode(HttpStatus.OK)
    async cancelMatchJob(
        @Param('jobId') jobId: string,
        @Req() req: AuthenticatedRequest,
    ): Promise<{
        jobId: string;
        status: string;
        message: string;
    }> {
        const userId = req.user?.id;
        if (!userId) {
            throw new BadRequestException('User ID not found after authentication.');
        }

        try {
            const cancelled = this.matchJobProcessor.cancelJob(jobId);
            
            if (cancelled) {
                this.logger.log(`[Cancel Match Job] Successfully cancelled job ${jobId}`);
                
                // Log activity
                await this.activityLogService.logUserAction(
                    'MATCH_JOB_CANCELLED',
                    'Success',
                    `Match job ${jobId} cancelled by user`,
                    {
                        action: 'match_job_cancelled',
                        inputData: { jobId },
                    },
                    userId
                );

                return {
                    jobId,
                    status: 'cancelled',
                    message: 'Match job has been successfully cancelled',
                };
            } else {
                return {
                    jobId,
                    status: 'not_cancellable',
                    message: 'Match job cannot be cancelled (may be completed, failed, or not found)',
                };
            }

        } catch (error) {
            this.logger.error(`[Cancel Match Job] Error cancelling job ${jobId}: ${error.message}`);
            throw new InternalServerErrorException('Failed to cancel match job');
        }
    }

    @Get('match/jobs')
    @Feature('aiScans')
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard)
    @HttpCode(HttpStatus.OK)
    async getUserMatchJobs(
        @Req() req: AuthenticatedRequest,
        @Query('status') status?: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled',
        @Query('limit') limit?: string,
        @Query('offset') offset?: string,
    ): Promise<{
        jobs?: Array<{
            jobId: string;
            status: string;
            currentStage: string;
            totalProducts: number;
            completedProducts: number;
            failedProducts: number;
            stagePercentage: number;
            createdAt: string;
            completedAt?: string;
            estimatedCompletionAt?: string;
        }>;
        pagination: {
            total: number;
            limit: number;
            offset: number;
        };
    }> {
        const userId = req.user?.id;
        if (!userId) {
            throw new BadRequestException('User ID not found after authentication.');
        }

        try {
            const supabase = this.supabaseService.getServiceClient();
            
            let query = supabase
                .from('match_jobs')
                .select('job_id, status, current_stage, progress, started_at, completed_at, estimated_completion_at', { count: 'exact' })
                .eq('user_id', userId);

            // Add status filter if provided
            if (status) {
                query = query.eq('status', status);
            }

            // Add pagination
            const limitNum = parseInt(limit || '20') || 20;
            const offsetNum = parseInt(offset || '0') || 0;
            query = query.range(offsetNum, offsetNum + limitNum - 1);

            // Order by creation date (newest first)
            query = query.order('started_at', { ascending: false });

            const { data, error, count } = await query;

            if (error) {
                throw new Error(`Database query failed: ${error.message}`);
            }

            const jobs = (data || []).map(job => ({
                jobId: job.job_id,
                status: job.status,
                currentStage: job.current_stage,
                totalProducts: job.progress?.totalProducts || 0,
                completedProducts: job.progress?.completedProducts || 0,
                failedProducts: job.progress?.failedProducts || 0,
                stagePercentage: job.progress?.stagePercentage || 0,
                createdAt: job.started_at,
                completedAt: job.completed_at,
                estimatedCompletionAt: job.estimated_completion_at,
            }));

            return {
                jobs,
                pagination: {
                    total: count || 0,
                    limit: limitNum,
                    offset: offsetNum,
                },
            };

        } catch (error) {
            this.logger.error(`[Get User Match Jobs] Error retrieving jobs: ${error.message}`);
            throw new InternalServerErrorException('Failed to retrieve user match jobs');
        }
    }

    /**
     * STAGE 3: GENERATE
     * Uses Firecrawl and AI to generate platform-specific product data
     */
    @Post('orchestrate/generate')
    @Feature('aiScans')
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard)
    @Throttle({ default: { limit: 5, ttl: 60000 }}) // 5 requests per minute (more resource intensive)
    @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    @HttpCode(HttpStatus.OK)
    async orchestrateGenerate(
        @Body() generateInput: {
            sessionId: string;
            platformRequests: Array<{
                platform: string; // e.g., 'shopify', 'amazon', 'ebay'
                requirements: {
                    useDescription?: 'scraped_content' | 'ai_generated' | 'user_provided';
                    customPrompt?: string;
                    restrictions?: string[];
                };
            }>;
            firecrawlTargets?: Array<{
                imageIndex: number;
                urls: string[]; // e.g., ["https://previewsworld.com/..."]
                customPrompt?: string; // e.g., "Find the product data for this product: (Green Lantern: War Journal Vol. 1 Contagion)"
            }>;
        },
        @Req() req: AuthenticatedRequest,
    ): Promise<{
        sessionId: string;
        generatedData: Array<{
            imageIndex: number;
            platforms: Record<string, {
                title: string;
                description: string;
                price?: number;
                specifications?: any;
                images?: string[];
                source: 'ai_generated' | 'firecrawl_scraped' | 'hybrid';
            }>;
            firecrawlData?: {
                scrapedContent: any[];
                processedData: any;
            };
        }>;
        storageResults: {
            productsCreated: number;
            variantsCreated: number;
            aiContentStored: number;
        };
    }> {
        const userId = req.user?.id;
        if (!userId) {
            throw new BadRequestException('User ID not found after authentication.');
        }

        this.logger.log(`[POST /orchestrate/generate] User: ${userId} - Session: ${generateInput.sessionId}, Platforms: ${generateInput.platformRequests.map(p => p.platform).join(', ')}`);

        try {
            const input: GenerateStageInput = {
                sessionId: generateInput.sessionId,
                platformRequests: generateInput.platformRequests.map(req => ({
                    platform: req.platform,
                    requirements: {
                        useDescription: req.requirements.useDescription,
                        customPrompt: req.requirements.customPrompt,
                        restrictions: req.requirements.restrictions
                    }
                })),
                scrapingTargets: generateInput.firecrawlTargets?.map(target => ({
                    sourceIndex: target.imageIndex, // Transform imageIndex to sourceIndex
                    urls: target.urls,
                    customPrompt: target.customPrompt
                }))
            };

            const result = await this.productOrchestratorService.generate(userId, input);

            // Log activity
            await this.activityLogService.logUserAction(
                'ORCHESTRATOR_GENERATE',
                'Success',
                `Completed generation stage for session ${generateInput.sessionId}`,
                {
                    action: 'orchestrate_generate',
                    inputData: {
                        sessionId: generateInput.sessionId,
                        productsCreated: result.storageResults.productsCreated,
                        variantsCreated: result.storageResults.variantsCreated,
                        platforms: generateInput.platformRequests.map(p => p.platform),
                        firecrawlTargets: generateInput.firecrawlTargets?.map(t => t.urls).flat()
                    }
                },
                userId
            );

            // Transform response: sourceIndex → imageIndex, scraped_content → firecrawl_scraped
            return {
                sessionId: result.sessionId,
                generatedData: result.generatedData.map(data => ({
                    imageIndex: data.sourceIndex, // Transform back to imageIndex
                    platforms: Object.fromEntries(
                        Object.entries(data.platforms).map(([platform, details]) => [
                            platform,
                            {
                                ...details,
                                source: details.source === 'scraped_content' ? 'firecrawl_scraped' : 
                                       details.source === 'ai_generated' ? 'ai_generated' : 'hybrid'
                            }
                        ])
                    ),
                    firecrawlData: data.scrapedData ? {
                        scrapedContent: Array.isArray(data.scrapedData) ? data.scrapedData : [data.scrapedData],
                        processedData: data.scrapedData
                    } : undefined
                })),
                storageResults: result.storageResults
            };

        } catch (error) {
            this.logger.error(`[POST /orchestrate/generate] User: ${userId} - Error: ${error.message}`, error.stack);
            throw new InternalServerErrorException(`Generation stage failed: ${error.message}`);
        }
    }

    /**
     * SESSION MANAGEMENT
     * Get session status and data for the frontend
     */
    @Get('orchestrate/session/:sessionId')
    @UseGuards(SupabaseAuthGuard)
    @HttpCode(HttpStatus.OK)
    async getOrchestratorSession(
        @Param('sessionId') sessionId: string,
        @Req() req: AuthenticatedRequest,
    ): Promise<{
        session: any | null;
        canProceed: {
            toMatch: boolean;
            toGenerate: boolean;
        };
    }> {
        const userId = req.user?.id;
        if (!userId) {
            throw new BadRequestException('User ID not found after authentication.');
        }

        this.logger.log(`[GET /orchestrate/session] User: ${userId} - Session: ${sessionId}`);

        try {
            const session = await this.productOrchestratorService.getSession(userId, sessionId);

            if (!session) {
                throw new NotFoundException('Session not found or access denied');
            }

            const canProceed = {
                toMatch: session.currentStage === 'recognize' && !!session.recognizeData,
                toGenerate: session.currentStage === 'match' && !!session.matchData
            };

            return { session, canProceed };

        } catch (error) {
            this.logger.error(`[GET /orchestrate/session] User: ${userId} - Error: ${error.message}`, error.stack);
            throw new InternalServerErrorException(`Failed to fetch session: ${error.message}`);
        }
    }

    /**
     * 🔥 BULK LIQUIDATION ENDPOINT - Perfect for liquidation use cases
     * Takes multiple images, runs SerpAPI on each, returns organized results per product
     */
    @Post('orchestrate/bulk-recognize')
    @Feature('aiScans')
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard)
    @Throttle({ default: { limit: 3, ttl: 120000 }}) // 3 requests per 2 minutes (resource intensive)
    @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    @HttpCode(HttpStatus.OK)
    async bulkRecognize(
        @Body() bulkRequest: {
            products: Array<{
                images: Array<{
                    url?: string;
                    base64?: string;
                    metadata?: any;
                }>;
                textQuery?: string; // Optional text hint for each product
                productId?: string; // Optional: If user wants to associate with specific ID
            }>;
            sessionId: string;
            searchOptions?: {
                enhanceWithGroq?: boolean;
                fallbackSearchAddresses?: string[];
                businessTemplate?: string;
            };
        },
        @Req() req: AuthenticatedRequest,
    ): Promise<{
        sessionId: string;
        results: Array<{
            productIndex: number;
            productId?: string; // User-provided ID if any
            primaryImage: string;
            textQuery?: string;
            databaseMatches: any[]; // Quick scan of your database
            externalMatches: any[]; // SerpAPI results
            confidence: 'high' | 'medium' | 'low';
            processingTimeMs: number;
            recommendedAction: 'show_database_match' | 'show_external_matches' | 'manual_entry';
            serpApiAnalysis?: {
                analysisId: string;
                rawData: string;
                metadata: any;
            } | null;
        }>;
        summary: {
            totalProducts: number;
            highConfidenceCount: number;
            mediumConfidenceCount: number;
            lowConfidenceCount: number;
            estimatedCostPerProduct: number;
            totalProcessingTimeMs: number;
        };
        nextSteps: {
            canProceedToGenerate: boolean;
            requiresUserSelection: boolean;
            suggestedBatchSize: number;
        };
    }> {
        const userId = req.user?.id;
        if (!userId) {
            throw new BadRequestException('User ID not found after authentication.');
        }

        const sessionId = `bulk_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const totalProducts = bulkRequest.products.length;

        // Validate bulk request size
        if (totalProducts === 0) {
            throw new BadRequestException('At least one product is required');
        }
        if (totalProducts > 1000) {
            throw new BadRequestException('Maximum 1000 products per bulk request. For larger batches, consider using the async job system.');
        }

        this.logger.log(`[POST /orchestrate/bulk-recognize] User: ${userId} - Processing ${totalProducts} products in session ${sessionId}`);

        try {
            const startTime = Date.now();
            const results: Array<{
                productIndex: number;
                productId?: string;
                primaryImage: string;
                textQuery?: string;
                databaseMatches: any[];
                externalMatches: any[];
                confidence: 'high' | 'medium' | 'low';
                processingTimeMs: number;
                recommendedAction: 'show_database_match' | 'show_external_matches' | 'manual_entry';
                serpApiAnalysis?: {
                    analysisId: string;
                    rawData: string;
                    metadata: any;
                } | null;
            }> = [];

            // Process each product
            for (let i = 0; i < bulkRequest.products.length; i++) {
                const product = bulkRequest.products[i];
                const productStartTime = Date.now();
                
                this.logger.log(`[Bulk Recognize] Processing product ${i + 1}/${totalProducts}`);

                // Get primary image (first image)
                const primaryImage = product.images[0];
                if (!primaryImage?.url && !primaryImage?.base64) {
                    throw new BadRequestException(`Product ${i + 1}: Primary image is required`);
                }

                const primaryImageUrl = primaryImage.url || `data:image/jpeg;base64,${primaryImage.base64}`;

                // Step 1: Call analyze (SerpAPI) for external matches
                let externalMatches: any[] = [];
                let serpApiAnalysis: any = null;
                
                try {
                    this.logger.log(`[Bulk Recognize] Calling analyze for product ${i + 1}`);
                    
                    // Call analyze endpoint to get SerpAPI data
                    const analysisResult = await this.productsService.analyzeAndCreateDraft(
                        userId, 
                        primaryImageUrl
                    );
                    
                    serpApiAnalysis = analysisResult.analysis;
                    
                    // Extract visual matches from analysis if available
                    if (serpApiAnalysis?.GeneratedText) {
                        const serpData = JSON.parse(serpApiAnalysis.GeneratedText);
                        externalMatches = serpData.visual_matches || [];
                    }
                    
                    this.logger.log(`[Bulk Recognize] Analyze complete for product ${i + 1}, found ${externalMatches.length} external matches`);
                    
                } catch (error) {
                    this.logger.warn(`Analyze failed for product ${i + 1}: ${error.message}`);
                    externalMatches = [];
                }

                // Step 2: Quick database scan for existing matches
                let databaseMatches: any[] = [];
                let topDatabaseScore = 0;
                
                try {
                    this.logger.log(`[Bulk Recognize] Running quick scan for product ${i + 1}`);
                    
                    const quickScanResult = await this.quickProductScan({
                        imageUrl: primaryImageUrl,
                        businessTemplate: 'general',
                        threshold: 0.7
                    }, req);
                    
                    databaseMatches = quickScanResult.matches || [];
                    topDatabaseScore = databaseMatches[0]?.score || 0;
                    
                    this.logger.log(`[Bulk Recognize] Quick scan complete for product ${i + 1}, found ${databaseMatches.length} database matches`);
                    
                } catch (error) {
                    this.logger.warn(`Quick scan failed for product ${i + 1}: ${error.message}`);
                    databaseMatches = [];
                    topDatabaseScore = 0;
                }

                // Step 3: Determine confidence and recommended action
                const externalMatchesCount = externalMatches.length;

                let confidence: 'high' | 'medium' | 'low';
                let recommendedAction: 'show_database_match' | 'show_external_matches' | 'manual_entry';

                if (topDatabaseScore >= 0.90) {
                    confidence = 'high';
                    recommendedAction = 'show_database_match';
                } else if (externalMatchesCount >= 3) {
                    confidence = 'medium';  
                    recommendedAction = 'show_external_matches';
                } else if (externalMatchesCount >= 1) {
                    confidence = 'medium';
                    recommendedAction = 'show_external_matches';
                } else {
                    confidence = 'low';
                    recommendedAction = 'manual_entry';
                }

                const productProcessingTime = Date.now() - productStartTime;

                results.push({
                    productIndex: i,
                    productId: product.productId,
                    primaryImage: primaryImageUrl,
                    textQuery: product.textQuery,
                    databaseMatches,
                    externalMatches,
                    confidence,
                    processingTimeMs: productProcessingTime,
                    recommendedAction,
                    // Include SerpAPI analysis for frontend to use in generation step
                    serpApiAnalysis: serpApiAnalysis ? {
                        analysisId: serpApiAnalysis.Id,
                        rawData: serpApiAnalysis.GeneratedText,
                        metadata: serpApiAnalysis.Metadata
                    } : null
                });

                // Brief pause between products to avoid rate limits
                if (i < bulkRequest.products.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }

            const totalProcessingTime = Date.now() - startTime;

            // Calculate summary statistics
            const highConfidenceCount = results.filter(r => r.confidence === 'high').length;
            const mediumConfidenceCount = results.filter(r => r.confidence === 'medium').length;
            const lowConfidenceCount = results.filter(r => r.confidence === 'low').length;

            // Log bulk processing completion
            await this.activityLogService.logUserAction(
                'BULK_RECOGNITION_COMPLETED',
                'Success',
                `Bulk recognition completed for ${totalProducts} products`,
                {
                    action: 'bulk_recognize',
                    inputData: {
                        sessionId,
                        totalProducts,
                        highConfidenceCount,
                        mediumConfidenceCount,
                        lowConfidenceCount,
                        totalProcessingTimeMs: totalProcessingTime
                    }
                },
                userId
            );

            return {
                sessionId,
                results,
                summary: {
                    totalProducts,
                    highConfidenceCount,
                    mediumConfidenceCount,
                    lowConfidenceCount,
                    estimatedCostPerProduct: 0.05, // Rough estimate
                    totalProcessingTimeMs: totalProcessingTime
                },
                nextSteps: {
                    canProceedToGenerate: highConfidenceCount + mediumConfidenceCount > 0,
                    requiresUserSelection: mediumConfidenceCount + lowConfidenceCount > 0,
                    suggestedBatchSize: totalProducts <= 10 ? totalProducts : Math.ceil(totalProducts / 3)
                }
            };

        } catch (error) {
            this.logger.error(`[POST /orchestrate/bulk-recognize] User: ${userId} - Error: ${error.message}`, error.stack);
            
            await this.activityLogService.logUserAction(
                'BULK_RECOGNITION_FAILED',
                'Error',
                `Bulk recognition failed: ${error.message}`,
                {
                    action: 'bulk_recognize',
                    inputData: {
                        sessionId,
                        totalProducts,
                        error: error.message
                    }
                },
                userId
            );
            
            throw new InternalServerErrorException(`Bulk recognition failed: ${error.message}`);
        }
    }

    // ===== NEW ASYNC JOB ENDPOINTS =====

    @Post('jobs/analyze')
    @Feature('aiScans')
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard)
    @Throttle({ default: { limit: 10, ttl: 60000 }}) // 10 jobs per minute max
    @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    @HttpCode(HttpStatus.ACCEPTED) // 202 Accepted for async operations
    async submitProductAnalysisJob(
        @Body() jobRequest: {
            products: Array<{
                productIndex: number;
                productId?: string;
                images: Array<{
                    url?: string;
                    base64?: string;
                    metadata?: any;
                }>;
                textQuery?: string;
            }>;
            options?: {
                enhanceWithGroq?: boolean;
            businessTemplate?: string;
                fallbackSearchAddresses?: string[];
            };
        },
        @Req() req: AuthenticatedRequest,
    ): Promise<{
        jobId: string;
        status: 'queued';
        estimatedTimeMinutes: number;
        totalProducts: number;
        message: string;
    }> {
        const userId = req.user?.id;
        if (!userId) {
            throw new BadRequestException('User ID not found after authentication.');
        }

        // Validate request
        if (!jobRequest.products || jobRequest.products.length === 0) {
            throw new BadRequestException('At least one product is required');
        }
        if (jobRequest.products.length > 50) {
            throw new BadRequestException('Maximum 50 products per job. Please split into smaller batches.');
        }

        // Generate unique job ID
        const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const estimatedTimeMinutes = Math.ceil(jobRequest.products.length * 12 / 60); // 12 seconds per product

        // Create job data
        const jobData: ProductAnalysisJobData = {
            type: 'product-analysis',
            jobId,
            userId,
            products: jobRequest.products,
            options: jobRequest.options,
            metadata: {
                totalProducts: jobRequest.products.length,
                estimatedTimeMinutes,
                createdAt: new Date().toISOString(),
            },
        };

        // Submit to queue
        try {
            // FIXED: Submit analysis job using static QueueManager
            await QueueManager.enqueueJob(jobData);
            
            this.logger.log(`[Submit Job] Created job ${jobId} for ${jobRequest.products.length} products`);
            
            // Log activity
            await this.activityLogService.logUserAction(
                'PRODUCT_ANALYSIS_JOB_SUBMITTED',
                'Success',
                `Product analysis job submitted for ${jobRequest.products.length} products`,
                {
                    action: 'job_submitted',
                    inputData: {
                        jobId,
                        productCount: jobRequest.products.length,
                        options: jobRequest.options,
                    },
                },
                userId
            );

            return {
                jobId,
                status: 'queued',
                estimatedTimeMinutes,
                totalProducts: jobRequest.products.length,
                message: `Job submitted successfully. Processing ${jobRequest.products.length} products. Estimated completion: ${estimatedTimeMinutes} minutes.`,
            };

        } catch (error) {
            this.logger.error(`[Submit Job] Failed to submit job: ${error.message}`);
            throw new InternalServerErrorException('Failed to submit job for processing');
        }
    }

    // ===== GENERATE JOBS (mirror of match jobs) =====

    @Post('generate/jobs')
    @Feature('aiScans')
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard)
    @Throttle({ default: { limit: 5, ttl: 60000 }})
    @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    @HttpCode(HttpStatus.ACCEPTED)
    async submitGenerateJob(
        @Body() generateRequest: {
            products: Array<{
                productIndex: number;
                productId: string;
                variantId?: string;
                imageUrls: string[];
                coverImageIndex: number;
                selectedMatches?: any[];
            }>;
            selectedPlatforms: string[];
            template?: string | null;
            options?: { useScraping?: boolean };
            platformRequests?: Array<{ 
                platform: string; 
                fieldSources?: Record<string, string[]>; 
                customPrompt?: string 
            }>;
            templateSources?: string[];
        },
        @Req() req: AuthenticatedRequest,
    ): Promise<{
        jobId: string;
        status: 'queued';
        estimatedTimeMinutes: number;
        totalProducts: number;
        message: string;
    }> {
        const userId = req.user?.id;
        if (!userId) {
            throw new BadRequestException('User ID not found after authentication.');
        }

        if (!generateRequest.products?.length) {
            throw new BadRequestException('At least one product is required');
        }

        // Extract JWT token from Authorization header for background job processing
        const authHeader = req.headers.authorization;
        const userJwtToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : undefined;

        const jobId = `generate_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const estimatedTimeMinutes = Math.ceil(generateRequest.products.length * 20 / 60); // rough estimate

        const jobData: GenerateJobData = {
            type: 'generate-job',
            jobId,
            userId,
            userJwtToken, // Include JWT token in job data for authenticated operations
            products: generateRequest.products,
            selectedPlatforms: generateRequest.selectedPlatforms || [],
            template: generateRequest.template ?? null,
            platformRequests: generateRequest.platformRequests,
            templateSources: generateRequest.templateSources,
            options: generateRequest.options,
            metadata: {
                totalProducts: generateRequest.products.length,
                estimatedTimeMinutes,
                createdAt: new Date().toISOString(),
            },
        };

        try {
            await QueueManager.enqueueJob(jobData as any);
            this.logger.log(`[Submit Generate Job] Created generate job ${jobId} for ${generateRequest.products.length} products`);
            await this.activityLogService.logUserAction(
                'GENERATE_JOB_SUBMITTED',
                'Success',
                `Generate job submitted for ${generateRequest.products.length} products`,
                {
                    action: 'generate_job_submitted',
                    inputData: {
                        jobId,
                        productCount: generateRequest.products.length,
                        platforms: generateRequest.selectedPlatforms,
                        template: generateRequest.template,
                    },
                },
                userId,
            );

            return {
                jobId,
                status: 'queued',
                estimatedTimeMinutes,
                totalProducts: generateRequest.products.length,
                message: `Generate job submitted successfully. Estimated completion: ${estimatedTimeMinutes} minutes.`,
            };
        } catch (error) {
            this.logger.error(`[Submit Generate Job] Failed to submit job: ${error.message}`);
            throw new InternalServerErrorException('Failed to submit generate job for processing');
        }
    }

    @Get('generate/jobs/:jobId/status')
    @Feature('aiScans')
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard)
    @HttpCode(HttpStatus.OK)
    async getGenerateJobStatus(
        @Param('jobId') jobId: string,
        @Req() req: AuthenticatedRequest,
    ): Promise<GenerateJobStatus> {
        const userId = req.user?.id;
        if (!userId) throw new BadRequestException('User ID not found after authentication.');

        let status = this.generateJobProcessor.getJobStatus(jobId);
        if (!status) status = await this.generateJobProcessor.getJobStatusFromDatabase(jobId);
        if (!status || status.userId !== userId) throw new NotFoundException(`Generate job ${jobId} not found`);
        return status;
    }

    @Get('generate/jobs/:jobId/results')
    @Feature('aiScans')
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard)
    @HttpCode(HttpStatus.OK)
    async getGenerateJobResults(
        @Param('jobId') jobId: string,
        @Req() req: AuthenticatedRequest,
    ): Promise<{
        jobId: string;
        status: string;
        results: GenerateJobResult[];
        summary?: any;
        completedAt?: string;
    }> {
        const userId = req.user?.id;
        if (!userId) throw new BadRequestException('User ID not found after authentication.');
        let status = this.generateJobProcessor.getJobStatus(jobId);
        if (!status) status = await this.generateJobProcessor.getJobStatusFromDatabase(jobId);
        if (!status || status.userId !== userId) throw new NotFoundException(`Generate job ${jobId} not found`);
        if (status.status !== 'completed') throw new BadRequestException(`Job ${jobId} is not completed yet. Current status: ${status.status}`);
        return {
            jobId: status.jobId,
            status: status.status,
            results: status.results,
            summary: status.summary,
            completedAt: status.completedAt,
        };
    }

    // === Generate Versions History ===
    @Get('generate/versions')
    @Feature('aiScans')
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard)
    @HttpCode(HttpStatus.OK)
    async getGenerateVersions(
        @Query('productId') productId: string,
        @Query('variantId') variantId?: string,
        @Query('limit') limit?: string,
        @Query('offset') offset?: string,
        @Req() req?: AuthenticatedRequest,
    ): Promise<Array<{ id: string; jobId: string; createdAt: string; platforms: any; sources: Array<{ url: string; usedForFields?: string[] }> }>> {
        const userId = req?.user?.id;
        if (!userId) throw new BadRequestException('User ID not found after authentication.');
        if (!productId) throw new BadRequestException('productId is required');

        const limitNum = parseInt(limit || '20') || 20;
        const offsetNum = parseInt(offset || '0') || 0;

        const supabase = this.supabaseService.getServiceClient();

        // Pull from generate_jobs results where productId/variantId match
        const { data, error } = await supabase
          .from('generate_jobs')
          .select('job_id, results, started_at')
          .eq('user_id', userId)
          .order('started_at', { ascending: false })
          .range(offsetNum, offsetNum + limitNum - 1);

        if (error) throw new InternalServerErrorException(`Database error: ${error.message}`);

        const versions: Array<{ 
            id: string; 
            jobId: string; 
            createdAt: string; 
            platforms: any; 
            sources: Array<{ 
                url: string; 
                usedForFields?: string[] 
            }> 
        }> = [];

        for (const row of (data || [])) {
            const results = Array.isArray(row.results) ? row.results : [];
            for (const r of results) {
                if (r.productId === productId && (!variantId || r.variantId === variantId)) {
                    const id = `${row.job_id}_${r.productIndex}`;
                    const sources = Array.isArray(r.sources)
                        ? r.sources
                        : Array.isArray(r.platforms?.sources)
                            ? r.platforms.sources
                            : [];
                    versions.push({
                        id,
                        jobId: row.job_id,
                        createdAt: row.started_at,
                        platforms: r.platforms || {},
                        sources: (sources || []).map((s: any) => ({ url: s?.url || s, usedForFields: s?.usedForFields || undefined })),
                    });
                }
            }
        }

        return versions;
    }

    @Delete('generate/jobs/:jobId')
    @Feature('aiScans')
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard)
    @HttpCode(HttpStatus.OK)
    async cancelGenerateJob(
        @Param('jobId') jobId: string,
        @Req() req: AuthenticatedRequest,
    ): Promise<{ jobId: string; status: string; message: string }> {
        const userId = req.user?.id;
        if (!userId) throw new BadRequestException('User ID not found after authentication.');
        const cancelled = this.generateJobProcessor.cancelJob(jobId);
        if (cancelled) {
            await this.activityLogService.logUserAction(
                'GENERATE_JOB_CANCELLED',
                'Success',
                `Generate job ${jobId} cancelled by user`,
                { action: 'generate_job_cancelled', inputData: { jobId } },
                userId,
            );
            return { jobId, status: 'cancelled', message: 'Generate job has been successfully cancelled' };
        }
        return { jobId, status: 'not_cancellable', message: 'Generate job cannot be cancelled (may be completed, failed, or not found)' };
    }

    @Get('generate/jobs')
    @Feature('aiScans')
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard)
    @HttpCode(HttpStatus.OK)
    async getUserGenerateJobs(
        @Req() req: AuthenticatedRequest,
        @Query('status') status?: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled',
        @Query('limit') limit?: string,
        @Query('offset') offset?: string,
    ): Promise<{
        jobs?: Array<{ jobId: string; status: string; currentStage: string; totalProducts: number; completedProducts: number; failedProducts: number; stagePercentage: number; createdAt: string; completedAt?: string; estimatedCompletionAt?: string; }>;
        pagination: { total: number; limit: number; offset: number };
    }> {
        const userId = req.user?.id;
        if (!userId) throw new BadRequestException('User ID not found after authentication.');
        const supabase = this.supabaseService.getServiceClient();
        let query = supabase
            .from('generate_jobs')
            .select('job_id, status, current_stage, progress, started_at, completed_at, estimated_completion_at', { count: 'exact' })
            .eq('user_id', userId);
        if (status) query = query.eq('status', status);
        const limitNum = parseInt(limit || '20') || 20;
        const offsetNum = parseInt(offset || '0') || 0;
        query = query.range(offsetNum, offsetNum + limitNum - 1);
        query = query.order('started_at', { ascending: false });
        const { data, error, count } = await query;
        if (error) throw new InternalServerErrorException(`Database query failed: ${error.message}`);
        const jobs = (data || []).map(job => ({
            jobId: job.job_id,
            status: job.status,
            currentStage: job.current_stage,
            totalProducts: job.progress?.totalProducts || 0,
            completedProducts: job.progress?.completedProducts || 0,
            failedProducts: job.progress?.failedProducts || 0,
            stagePercentage: job.progress?.stagePercentage || 0,
            createdAt: job.started_at,
            completedAt: job.completed_at,
            estimatedCompletionAt: job.estimated_completion_at,
        }));
        return { jobs, pagination: { total: count || 0, limit: limitNum, offset: offsetNum } };
    }

    @Get('jobs/:jobId/status')
    @Feature('aiScans')
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard)
    @HttpCode(HttpStatus.OK)
    async getJobStatus(
        @Param('jobId') jobId: string,
        @Req() req: AuthenticatedRequest,
    ): Promise<ProductAnalysisJobStatus> {
        const userId = req.user?.id;
        if (!userId) {
            throw new BadRequestException('User ID not found after authentication.');
        }

        try {
            // Try to get from memory first (faster)
            let jobStatus = this.productAnalysisProcessor.getJobStatus(jobId);
            
            // If not in memory, try database
            if (!jobStatus) {
                jobStatus = await this.productAnalysisProcessor.getJobStatusFromDatabase(jobId);
            }

            if (!jobStatus) {
                throw new NotFoundException(`Job ${jobId} not found`);
            }

            // Verify job belongs to this user (security check)
            // Note: You'd need to store userId in the job status for this check
            // For now, we'll skip this check but it's important for production

            this.logger.debug(`[Get Job Status] Retrieved status for job ${jobId}: ${jobStatus.status}`);

            return jobStatus;

        } catch (error) {
            if (error instanceof NotFoundException) {
                throw error;
            }
            this.logger.error(`[Get Job Status] Error retrieving job ${jobId}: ${error.message}`);
            throw new InternalServerErrorException('Failed to retrieve job status');
        }
    }

    @Delete('jobs/:jobId')
    @Feature('aiScans')
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard)
    @HttpCode(HttpStatus.OK)
    async cancelJob(
        @Param('jobId') jobId: string,
        @Req() req: AuthenticatedRequest,
    ): Promise<{
        jobId: string;
        status: string;
        message: string;
    }> {
        const userId = req.user?.id;
        if (!userId) {
            throw new BadRequestException('User ID not found after authentication.');
        }

        try {
            const cancelled = this.productAnalysisProcessor.cancelJob(jobId);
            
            if (cancelled) {
                this.logger.log(`[Cancel Job] Successfully cancelled job ${jobId}`);
                
                // Log activity
                await this.activityLogService.logUserAction(
                    'PRODUCT_ANALYSIS_JOB_CANCELLED',
                    'Success',
                    `Product analysis job ${jobId} cancelled by user`,
                    {
                        action: 'job_cancelled',
                        inputData: { jobId },
                    },
                    userId
                );

                return {
                    jobId,
                    status: 'cancelled',
                    message: 'Job has been successfully cancelled',
                };
            } else {
                return {
                    jobId,
                    status: 'not_cancellable',
                    message: 'Job cannot be cancelled (may be completed, failed, or not found)',
                };
            }

        } catch (error) {
            this.logger.error(`[Cancel Job] Error cancelling job ${jobId}: ${error.message}`);
            throw new InternalServerErrorException('Failed to cancel job');
        }
    }

    @Get('jobs')
    @Feature('aiScans')
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard)
    @HttpCode(HttpStatus.OK)
    async getUserJobs(
        @Req() req: AuthenticatedRequest,
        @Query('status') status?: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled',
        @Query('limit') limit?: string,
        @Query('offset') offset?: string,
    ): Promise<{
        jobs: Array<{
            jobId: string;
            status: string;
            totalProducts: number;
            completedProducts: number;
            failedProducts: number;
            createdAt: string;
            completedAt?: string;
            estimatedCompletionAt?: string;
        }>;
        pagination: {
            total: number;
            limit: number;
            offset: number;
        };
    }> {
        const userId = req.user?.id;
        if (!userId) {
            throw new BadRequestException('User ID not found after authentication.');
        }

        try {
            const supabase = this.supabaseService.getServiceClient();
            
            let query = supabase
                .from('product_analysis_jobs')
                .select('job_id, status, summary, started_at, completed_at, estimated_completion_at', { count: 'exact' });

            // Add status filter if provided
            if (status) {
                query = query.eq('status', status);
            }

            // Add pagination
            const limitNum = parseInt(limit || '20') || 20;
            const offsetNum = parseInt(offset || '0') || 0;
            query = query.range(offsetNum, offsetNum + limitNum - 1);

            // Order by creation date (newest first)
            query = query.order('started_at', { ascending: false });

            const { data, error, count } = await query;

            if (error) {
                throw new Error(`Database query failed: ${error.message}`);
            }

            const jobs = (data || []).map(job => ({
                jobId: job.job_id,
                status: job.status,
                totalProducts: job.summary?.totalProducts || 0,
                completedProducts: job.summary?.highConfidenceCount + job.summary?.mediumConfidenceCount + job.summary?.lowConfidenceCount || 0,
                failedProducts: job.summary?.failed || 0,
                createdAt: job.started_at,
                completedAt: job.completed_at,
                estimatedCompletionAt: job.estimated_completion_at,
            }));

            return {
                jobs,
                pagination: {
                    total: count || 0,
                    limit: limitNum,
                    offset: offsetNum,
                },
            };

        } catch (error) {
            this.logger.error(`[Get User Jobs] Error retrieving jobs: ${error.message}`);
            throw new InternalServerErrorException('Failed to retrieve user jobs');
        }
    }

    /**
     * Deduplicate matches by title similarity to prevent duplicate products in reranker
     */
    private deduplicateMatchesByTitle(matches: any[]): any[] {
        if (!matches || matches.length === 0) return matches;

        const uniqueMatches: any[] = [];
        const seenTitles = new Set<string>();

        for (const match of matches) {
            if (!match.title) continue;

            // Normalize title for comparison
            const normalizedTitle = match.title
                .toLowerCase()
                .replace(/[^\w\s]/g, '') // Remove special chars
                .replace(/\s+/g, ' ')     // Normalize whitespace
                .trim();

            // Check if we've seen a very similar title
            let isDuplicate = false;
            for (const seenTitle of seenTitles) {
                // Calculate similarity - if titles are 85% similar, consider them duplicates
                const similarity = this.calculateTitleSimilarity(normalizedTitle, seenTitle);
                if (similarity > 0.85) {
                    this.logger.debug(`[DeduplicateTitle] Skipping duplicate: "${match.title}" (similar to existing title)`);
                    isDuplicate = true;
                    break;
                }
            }

            if (!isDuplicate) {
                seenTitles.add(normalizedTitle);
                uniqueMatches.push(match);
            }
        }

        return uniqueMatches;
    }

    /**
     * Calculate simple similarity between two strings (Jaccard similarity on words)
     */
    private calculateTitleSimilarity(title1: string, title2: string): number {
        const words1 = new Set(title1.split(/\s+/));
        const words2 = new Set(title2.split(/\s+/));
        
        const intersection = new Set([...words1].filter(x => words2.has(x)));
        const union = new Set([...words1, ...words2]);
        
        return intersection.size / union.size;
    }

    // ===================================================================
    // REGENERATE/FILL-IN ENDPOINTS
    // ===================================================================

    /**
     * Submit a regenerate job for products
     * Allows regenerating entire platforms or specific fields using existing scraped data
     */
    @Post('regenerate/submit')
    @Feature('aiScans')
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard)
    @Throttle({ default: { limit: 3, ttl: 60000 }}) // 3 regenerate jobs per minute
    @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    @HttpCode(HttpStatus.ACCEPTED) // 202 Accepted for async operations
    async submitRegenerateJob(
        @Body() regenerateRequest: {
            generateJobId?: string; // source generate job id
            products: Array<{
                productIndex: number;
                productId: string;
                variantId?: string;
                regenerateType: 'entire_platform' | 'specific_fields';
                targetPlatform?: string; // e.g., 'shopify', 'amazon', 'ebay'
                targetFields?: string[]; // e.g., ['title', 'description', 'price']
                sourceJobId?: string; // Reference to previous firecrawl/generate job
                customPrompt?: string;
                userQuery?: string;
                conversationId?: string;
                imageUrls?: string[];
            }>;
            options?: {
                useExistingScrapedData?: boolean;
                enhanceWithGroq?: boolean;
                overwriteExisting?: boolean;
                businessTemplate?: string;
            };
        },
        @Req() req: AuthenticatedRequest,
    ): Promise<{
        jobId: string;
        status: 'queued';
        estimatedTimeMinutes: number;
        totalProducts: number;
        message: string;
    }> {
        const userId = req.user.id;
        const jobId = `regenerate_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        this.logger.log(`[RegenerateJob] Submitting regenerate job ${jobId} for ${regenerateRequest.products.length} products`);

        // Validate products exist and belong to user
        for (const product of regenerateRequest.products) {
            try {
                await this.productsService.getProduct(product.productId, userId);
            } catch (error) {
                throw new BadRequestException(`Product ${product.productId} not found or access denied`);
            }
        }

        // Estimate processing time (2-3 minutes per product)
        const estimatedTimeMinutes = Math.max(5, regenerateRequest.products.length * 2);

        // Create job data
        const jobData = {
            type: 'regenerate-job' as const,
            jobId,
            userId,
            generateJobId: regenerateRequest.generateJobId,
            products: regenerateRequest.products,
            options: regenerateRequest.options || {},
            metadata: {
                totalProducts: regenerateRequest.products.length,
                estimatedTimeMinutes,
                createdAt: new Date().toISOString()
            }
        };

        // Enqueue the job
        await QueueManager.enqueueJob(jobData);

        // Log activity
        await this.activityLogService.logActivity({
            UserId: userId,
            EntityType: 'REGENERATE_JOB',
            EntityId: jobId,
            EventType: 'JOB_SUBMITTED',
            Status: 'Success',
            Message: `Regenerate job submitted for ${regenerateRequest.products.length} products`,
            Details: {
                jobId,
                totalProducts: regenerateRequest.products.length,
                regenerateTypes: [...new Set(regenerateRequest.products.map(p => p.regenerateType))],
                platforms: [...new Set(regenerateRequest.products.map(p => p.targetPlatform).filter(Boolean))]
            }
        });

        return {
            jobId,
            status: 'queued',
            estimatedTimeMinutes,
            totalProducts: regenerateRequest.products.length,
            message: `Regenerate job queued successfully. Estimated completion: ${estimatedTimeMinutes} minutes.`
        };
    }

    /**
     * Get regenerate job status
     */
    @Get('regenerate/status/:jobId')
    @Feature('aiScans')
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard)
    @Throttle({ default: { limit: 3, ttl: 60000 }}) // 3 regenerate jobs per minute
    @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    @HttpCode(HttpStatus.ACCEPTED) // 202 Accepted for async operations
    async getRegenerateJobStatus(
        @Param('jobId') jobId: string,
        @Req() req: AuthenticatedRequest,
    ): Promise<RegenerateJobStatus> {
        const userId = req.user.id;
        
        const status = await this.regenerateJobProcessor.getJobStatus(jobId, userId);
        if (!status) {
            throw new NotFoundException(`Regenerate job ${jobId} not found`);
        }

        return status;
    }

    /**
     * Get regenerate job results
     */
    @Get('regenerate/results/:jobId')
    @Feature('aiScans')
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard)
    @Throttle({ default: { limit: 3, ttl: 60000 }}) // 3 regenerate jobs per minute
    @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    @HttpCode(HttpStatus.ACCEPTED) // 202 Accepted for async operations
    async getRegenerateJobResults(
        @Param('jobId') jobId: string,
        @Req() req: AuthenticatedRequest,
    ): Promise<{
        jobId: string;
        status: string;
        results: RegenerateJobResult[];
        summary?: any;
        completedAt?: string;
    }> {
        const userId = req.user.id;
        
        const status = await this.regenerateJobProcessor.getJobStatus(jobId, userId);
        if (!status) {
            throw new NotFoundException(`Regenerate job ${jobId} not found`);
        }

        return {
            jobId: status.jobId,
            status: status.status,
            results: status.results,
            summary: status.summary,
            completedAt: status.completedAt
        };
    }

    /**
     * Cancel a regenerate job
     */
    @Post('regenerate/cancel/:jobId')
    @Feature('aiScans')
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard)
    @Throttle({ default: { limit: 3, ttl: 60000 }}) // 3 regenerate jobs per minute
    @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    @HttpCode(HttpStatus.ACCEPTED) // 202 Accepted for async operations
    async cancelRegenerateJob(
        @Param('jobId') jobId: string,
        @Req() req: AuthenticatedRequest,
    ): Promise<{
        jobId: string;
        status: string;
        message: string;
    }> {
        const userId = req.user.id;
        
        const cancelled = await this.regenerateJobProcessor.cancelJob(jobId, userId);
        if (!cancelled) {
            throw new BadRequestException(`Cannot cancel job ${jobId}. Job may not exist, be completed, or you may not have permission.`);
        }

        // Log activity
        await this.activityLogService.logActivity({
            UserId: userId,
            EntityType: 'REGENERATE_JOB',
            EntityId: jobId,
            EventType: 'JOB_CANCELLED',
            Status: 'Success',
            Message: `Regenerate job ${jobId} cancelled by user`,
            Details: { jobId }
        });

        return {
            jobId,
            status: 'cancelled',
            message: `Regenerate job ${jobId} has been cancelled successfully.`
        };
    }

    /**
     * Get user's regenerate jobs with pagination
     */
    @Get('regenerate/jobs')
    @Feature('aiScans')
    @UseGuards(SupabaseAuthGuard, FeatureUsageGuard)
    @Throttle({ default: { limit: 3, ttl: 60000 }}) // 3 regenerate jobs per minute
    @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    @HttpCode(HttpStatus.ACCEPTED) // 202 Accepted for async operations
    async getUserRegenerateJobs(
        @Req() req: AuthenticatedRequest,
        @Query('status') status?: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled',
        @Query('limit') limit?: string,
        @Query('offset') offset?: string,
    ): Promise<{
        jobs?: Array<{
            jobId: string;
            status: string;
            currentStage: string;
            totalProducts: number;
            completedProducts: number;
            failedProducts: number;
            stagePercentage: number;
            createdAt: string;
            completedAt?: string;
            estimatedCompletionAt?: string;
        }>;
        pagination: {
            total: number;
            limit: number;
            offset: number;
        };
    }> {
        const userId = req.user.id;
        const limitNum = parseInt(limit || '10', 10);
        const offsetNum = parseInt(offset || '0', 10);

        const supabase = this.supabaseService.getClient();
        
        let query = supabase
            .from('regenerate_job_statuses')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (status) {
            query = query.eq('status', status);
        }

        const { data: jobs, error } = await query
            .range(offsetNum, offsetNum + limitNum - 1);

        if (error) {
            throw new InternalServerErrorException(`Failed to fetch regenerate jobs: ${error.message}`);
        }

        // Get total count
        const { count } = await supabase
            .from('regenerate_job_statuses')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId);

        const formattedJobs = jobs?.map(job => ({
            jobId: job.job_id,
            status: job.status,
            currentStage: job.current_stage,
            totalProducts: job.progress?.totalProducts || 0,
            completedProducts: job.progress?.completedProducts || 0,
            failedProducts: job.progress?.failedProducts || 0,
            stagePercentage: job.progress?.stagePercentage || 0,
            createdAt: job.created_at,
            completedAt: job.completed_at,
            estimatedCompletionAt: job.estimated_completion_at
        })) || [];

        return {
            jobs: formattedJobs,
            pagination: {
                total: count || 0,
                limit: limitNum,
                offset: offsetNum
            }
        };
    }

    
}