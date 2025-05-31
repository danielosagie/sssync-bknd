import { Injectable, Logger, NotFoundException, BadRequestException, InternalServerErrorException, HttpException, HttpStatus } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseService } from '../common/supabase.service';
import { ImageRecognitionService, SerpApiLensResponse, VisualMatch } from './image-recognition/image-recognition.service';
import { AiGenerationService, GeneratedDetails } from './ai-generation/ai-generation.service';
import { ConfigService } from '@nestjs/config';
import * as SerpApiClient from 'google-search-results-nodejs';
import { PublishProductDto, PublishIntent } from './dto/publish-product.dto';
import { PlatformAdapterRegistry } from '../platform-adapters/adapter.registry';
import { PlatformConnectionsService } from '../platform-connections/platform-connections.service';
import { ActivityLogService } from '../common/activity-log.service';
import { Product, ProductVariant, ProductImage } from '../common/types/supabase.types';
import * as QueueManager from '../queue-manager';

// Export the types
export type { SerpApiLensResponse, VisualMatch } from './image-recognition/image-recognition.service';
export type { GeneratedDetails } from './ai-generation/ai-generation.service';

export type SimpleProductVariant = Pick<ProductVariant, 
    'Id' | 
    'ProductId' | 
    'Sku' | 
    'Title' | 
    'Price' | 
    'Barcode' | 
    'Weight' | 
    'WeightUnit' | 
    'Options' | 
    'Description' | 
    'CompareAtPrice' | 
    'RequiresShipping' | 
    'IsTaxable' | 
    'TaxCode' | 
    'ImageId'
>;

export interface SimpleProduct {
    Id: string;
    UserId: string;
    Title: string;
    Description: string | null;
    IsArchived: boolean;
}

export interface SimpleAiGeneratedContent {
    Id: string;
    ProductId: string;
    ContentType: string;
    SourceApi: string;
    GeneratedText: string;
    Metadata?: any;
    IsActive: boolean;
    CreatedAt: string;
    UpdatedAt: string;
}

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);
  private readonly serpApi: SerpApiClient.GoogleSearch | undefined;

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly imageRecognitionService: ImageRecognitionService,
    private readonly aiGenerationService: AiGenerationService,
    private readonly configService: ConfigService,
    private readonly adapterRegistry: PlatformAdapterRegistry,
    private readonly connectionsService: PlatformConnectionsService,
    private readonly activityLogService: ActivityLogService,
  ) {
    this.logger.log('ProductsService Constructor called.');

    // --- Explicitly log SERPAPI_KEY retrieval ---
    const serpApiKey = this.configService.get<string>('SERPAPI_API_KEY'); // Check THIS EXACT NAME
    this.logger.log(`[ProductsService Constructor] Read SERPAPI_API_KEY: ${serpApiKey ? '*** (Exists)' : '!!! NOT FOUND / UNDEFINED !!!'}`);
    // Optional: Log the key type or first few chars for verification (NEVER log the full key)
    if (serpApiKey) {
       this.logger.debug(`[ProductsService Constructor] SERPAPI_API_KEY type: ${typeof serpApiKey}, length: ${serpApiKey.length}`);
    }
    // --- End logging ---

    if (!serpApiKey) {
        this.logger.warn('SERPAPI_API_KEY is not configured. Product analysis will be disabled.');
        this.serpApi = undefined; // Ensure serpApi is undefined
    } else {
        try {
            this.serpApi = new SerpApiClient.GoogleSearch(serpApiKey);
            this.logger.log('ProductsService: SerpApi client initialized successfully.');
        } catch (error) {
            this.logger.error(`Failed to initialize SerpApi client: ${error.message}`, error.stack);
            this.serpApi = undefined; // Ensure serpApi is undefined on init failure
        }
    }
  }

  private getSupabaseClient(): SupabaseClient {
    return this.supabaseService.getClient();
  }

  /**
   * Analyzes images, creates draft product/variant, saves images & analysis result.
   */
  async analyzeAndCreateDraft(
    userId: string,
    imageUrl: string,
    // Use 'any' or a simple inline type for now instead of CreateDraftProductDto
    createDto?: { title?: string; description?: string; price?: number; sku?: string },
  ): Promise<{ product: SimpleProduct; variant: SimpleProductVariant; analysis?: SimpleAiGeneratedContent }> {
    const supabase = this.getSupabaseClient();
    this.logger.log(`Starting product analysis...`);

    let analysisResultJson: SerpApiLensResponse | null = null;
    let productId: string | null = null;
    let variantId: string | null = null;
    let aiContentId: string | null = null;
    let product: SimpleProduct | null = null;
    let variant: SimpleProductVariant | null = null;
    let analysis: SimpleAiGeneratedContent | null = null;
    let analysisAttempted = false; // Flag to track if we tried to analyze

    try {
      // 1. Analyze Image
      if (this.serpApi) {
         analysisAttempted = true; // Mark that we are attempting it
         this.logger.debug(`Analyzing image with SerpApi Lens: ${imageUrl}`);
         analysisResultJson = await new Promise<SerpApiLensResponse>((resolve) => { // Removed reject path
             this.serpApi.json({
                 engine: "google_lens",
                 url: imageUrl,
                 hl: "en", // Optional: language
                 gl: "us", // Optional: country
             }, (result) => {
                 // Resolve with the result, whether it's data or an error payload from SerpApi
                 resolve(result);
             });
         });
         // Log success or SerpApi's error *after* the promise resolves
         if (analysisResultJson?.error) {
             this.logger.error(`SerpApi Lens analysis failed: ${analysisResultJson.error}`);
             // Don't store this result later, but the attempt was made
         } else if (analysisResultJson) {
             this.logger.log(`SerpApi Lens analysis successful (or resolved without data).`);
         } else {
             this.logger.warn(`SerpApi Lens promise resolved with unexpected null/undefined result.`);
         }
      } else {
          this.logger.warn('SerpApi not configured, skipping analysis.');
      }

      // 2. Create Product placeholder using Supabase
      const { data: productData, error: productError } = await supabase
        .from('Products') // Use DB table name
        .insert({
          UserId: userId, // Ensure column names match DB
          IsArchived: false,
          // Add other default fields if necessary
        })
        .select() // Select the created row
        .single(); // Expect a single row back

      if (productError || !productData) {
        this.logger.error(`Failed to create product placeholder: ${productError?.message}`, productError);
        throw new InternalServerErrorException('Failed to initiate product creation.');
      }
      product = productData as SimpleProduct; // Assign to outer scope variable
      productId = product.Id; // Assign ID
      this.logger.log(`Created Product placeholder with ID: ${productId}`);

      // 3. Create Product Variant using Supabase
      const title = createDto?.title || analysisResultJson?.visual_matches?.[0]?.title || 'Untitled Product';
      const description = createDto?.description || analysisResultJson?.visual_matches?.[0]?.snippet || null; // Use null for empty text?
      const priceStr = createDto?.price?.toString() || analysisResultJson?.visual_matches?.[0]?.price?.value?.replace(/[^0-9.]/g, '');
      const price = priceStr ? parseFloat(priceStr) : 0.00;
      const sku = createDto?.sku || `DRAFT-${productId.substring(0, 8)}`;

       const { data: variantData, error: variantError } = await supabase
          .from('ProductVariants') // Use DB table name
          .insert({
              ProductId: productId, // Ensure column names match DB
              UserId: userId,
              Sku: sku,
              Title: title,
              Description: description,
              Price: price, // Ensure DB column type matches (numeric/decimal)
              // Add other fields matching DB schema if needed
          })
          .select()
          .single();

        if (variantError || !variantData) {
             this.logger.error(`Failed to create product variant: ${variantError?.message}`, variantError);
             // Set flags or throw, cleanup will handle deletion of product
             throw new InternalServerErrorException('Failed to create product variant.');
        }
        variant = variantData as SimpleProductVariant; // Assign to outer scope variable
        variantId = variant.Id; // Assign ID
        this.logger.log(`Created ProductVariant with ID: ${variantId} for Product ${productId}`);

        // 4. Store Analysis Results (only if analysis was attempted and successful from SerpApi)
        if (analysisAttempted && analysisResultJson && !analysisResultJson.error) {
          const metadata = {
              searchUrl: imageUrl,
              searchEngine: analysisResultJson?.search_parameters?.engine,
              topMatchTitle: analysisResultJson?.visual_matches?.[0]?.title,
              topMatchSource: analysisResultJson?.visual_matches?.[0]?.source,
          };

          const { data: aiData, error: aiError } = await supabase
            .from('AiGeneratedContent') // Use DB table name
            .insert({
                ProductId: productId, // Ensure column names match DB
                ContentType: 'product_analysis',
                SourceApi: 'serpapi_google_lens',
                GeneratedText: JSON.stringify(analysisResultJson), // Store JSON string
                Metadata: metadata, // Ensure DB column type is jsonb
                IsActive: false,
            })
            .select()
            .single();

          if (aiError || !aiData) {
             // Log error but don't necessarily fail the whole operation, product/variant exist
             this.logger.error(`Failed to store AI analysis results: ${aiError?.message}`, aiError);
          } else {
             analysis = aiData as SimpleAiGeneratedContent; // Assign to outer scope variable
             aiContentId = analysis.Id; // Assign ID
             this.logger.log(`Stored AI analysis results with ID: ${aiContentId}`);
          }
        } else if (analysisAttempted && analysisResultJson?.error) {
           this.logger.warn(`Skipping storage of AI analysis due to error during analysis for product ${productId}.`);
        } else if (analysisAttempted) {
            this.logger.warn(`Skipping storage of AI analysis due to missing results for product ${productId}.`);
        }

        // --- >>> 5. Decrement Usage Count via RPC <<< ---
        // Decrement ONLY IF analysis was attempted (meaning SerpApi is configured)
        if (analysisAttempted) {
            this.logger.debug(`Attempting to decrement AiScans for user ${userId} via RPC (Analysis was attempted).`);
            const { data: rpcData, error: rpcError } = await supabase
                .rpc('decrement_ai_scans', { target_user_id: userId });

            if (rpcError) {
                this.logger.error(`Error calling decrement_ai_scans RPC for user ${userId}: ${rpcError.message}`, rpcError);
                // Decide: Fail request? Or just log? For now, just log.
            } else if (rpcData === true) {
                this.logger.log(`Successfully decremented AiScans for user ${userId}.`);
            } else {
                this.logger.warn(`Decrement_ai_scans RPC returned false for user ${userId}. Limit likely hit concurrently or other issue.`);
                // Decide: Fail request? Or just log? For now, just log.
            }
        } else {
            this.logger.debug(`Skipping AI Scan decrement for user ${userId} because analysis was not attempted (SerpApi not configured).`);
        }
        // --- >>> End Decrement Usage Count <<< ---

        // Ensure we have product and variant before returning
        if (!product || !variant) {
             throw new InternalServerErrorException("Failed to retrieve created product or variant details.");
        }
        return { product, variant, analysis: analysis ?? undefined };

    } catch (error) {
      this.logger.error(`Error during product analysis/draft creation for user ${userId}: ${error.message}`, error.stack);

      // --- Cleanup Logic using Supabase ---
      this.logger.warn(`Attempting cleanup due to error... ProductID: ${productId}, VariantID: ${variantId}, AiContentID: ${aiContentId}`);
      try {
           if (aiContentId) { // If AI content was created before error
               this.logger.log(`Deleting AiGeneratedContent: ${aiContentId}`);
               await supabase.from('AiGeneratedContent').delete().match({ Id: aiContentId })
                   .then(({ error }) => { if(error) throw error; });
           }
           if (variantId) { // If variant was created before error
              this.logger.log(`Deleting ProductVariant: ${variantId}`);
              await supabase.from('ProductVariants').delete().match({ Id: variantId })
                  .then(({ error }) => { if(error) throw error; });
           }
           // IMPORTANT: Product deletion cascades via FK constraint, but double-check your schema.
           // If no cascade, or to be safe, delete Product last.
           if (productId) { // If product was created before error (and variant/ai deleted)
               this.logger.log(`Deleting Product: ${productId}`);
               await supabase.from('Products').delete().match({ Id: productId })
                   .then(({ error }) => { if(error) throw error; });
           }
      } catch (cleanupError) {
           this.logger.error(`Error during cleanup process: ${cleanupError.message}`, cleanupError.stack);
           // Avoid masking original error, but log this failure
      }
      // --- End Cleanup ---

      if (error instanceof BadRequestException || error instanceof NotFoundException || error instanceof InternalServerErrorException) {
          throw error; // Re-throw specific HTTP errors
      }
      // Throw a generic error for others
      throw new InternalServerErrorException('Failed to create product draft due to an unexpected error.');
    }
  }

  // Endpoint 2 Logic: Generate Details (Refactored Input)
  async generateDetailsForDraft( // Renamed for clarity
    userId: string, // Keep userId for verification/logging if needed
    productId: string,
    variantId: string,
    imageUrls: string[], // Needed again for AI service
    coverImageIndex: number,
    selectedPlatforms: string[],
    selectedMatch?: VisualMatch | null, // Use the specific match selected by user
  ): Promise<{ generatedDetails: GeneratedDetails | null }> { // Only return generatedDetails now

    // Optional: Fetch Product/Variant to verify ownership/existence if needed
    // const { data: variantCheck } = await this.supabase.from('ProductVariants').select('Id, UserId').match({ Id: variantId, UserId: userId }).single();
    // if (!variantCheck) throw new NotFoundException(`Variant not found or access denied.`);

    if (coverImageIndex < 0 || coverImageIndex >= imageUrls.length) {
        throw new BadRequestException('Invalid cover image index.');
    }
    if (!selectedPlatforms || selectedPlatforms.length === 0) {
      throw new BadRequestException('At least one target platform is required.');
    }

    this.logger.log(`Service: Generating details for product ${productId} / variant ${variantId}, platforms: ${selectedPlatforms.join(', ')}`);

    // 1. Call AI Generation Service
    const coverImageUrl = imageUrls[coverImageIndex];
    const generatedDetails = await this.aiGenerationService.generateProductDetails(
      imageUrls,
      coverImageUrl,
      selectedPlatforms,
      selectedMatch ? { visual_matches: [selectedMatch] } : null, // Pass selected match context if available
                                                                  // The AI service prompt needs slight adjustment to look for visual_matches[0] if present
    );

     if (!generatedDetails) {
         // Log already happens in AI service
         throw new InternalServerErrorException('Failed to generate product details from AI.');
     }

    // 2. Save Generated AI Content to DB
     const aiContentInserts: Omit<SimpleAiGeneratedContent, 'Id' | 'CreatedAt'>[] = [];
     let primaryDetails: any = null; // Store details for the first platform to update the variant

     const now = new Date().toISOString();
     Object.entries(generatedDetails).forEach(([platform, details], index) => {
         aiContentInserts.push({
             ProductId: productId,
             ContentType: 'groq_maverick_details',
             SourceApi: 'groq-maverick',
             GeneratedText: JSON.stringify(details),
             Metadata: { platform: platform.toLowerCase(), selectedMatch: selectedMatch ?? null },
             IsActive: true,
             UpdatedAt: new Date().toISOString()
         });
         if (index === 0) { // Use details from the first platform for the main variant record
             primaryDetails = details;
         }
     });

     const { error: aiError } = await this.getSupabaseClient().from('AiGeneratedContent').insert(aiContentInserts);
     if (aiError) {
         this.logger.error(`Failed to save Groq generated content for product ${productId}: ${aiError.message}`, aiError);
         // Don't necessarily fail the whole request, but log it
     }

    // 3. (Enhancement) Update ProductVariant with primary generated details
     if (primaryDetails) {
         const { error: variantUpdateError } = await this.getSupabaseClient().from('ProductVariants')
            .update({
                Title: primaryDetails.title ?? 'Generated Product',
                Description: primaryDetails.description ?? 'See details',
                Price: primaryDetails.price ?? 0,
                UpdatedAt: new Date().toISOString(), // Explicitly set UpdatedAt
                // Add other fields matching DB schema
            })
            .match({ Id: variantId });

         if (variantUpdateError) {
             this.logger.error(`Failed to update variant ${variantId} with generated details: ${variantUpdateError.message}`, variantUpdateError);
         } else {
              this.logger.log(`Updated variant ${variantId} with generated details.`);
         }
     }

    this.logger.log(`Successfully generated details for product ${productId} / variant ${variantId}`);
    return { generatedDetails }; // Return only the details for the form
  }

   // --- TODO: Add method for saving edited data (Step 4/5 from frontend) ---
   // async saveListingDetails(userId: string, variantId: string, formData: any) { ... }

   // --- TODO: Add method for publishing to platforms (Step 5 from frontend) ---
   // async publishListing(userId: string, variantId: string, targetPlatforms: string[]) { ... }

  async saveOrPublishListing(userId: string, dto: PublishProductDto): Promise<void> {
    const supabase = this.getSupabaseClient();
    const { productId, variantId, publishIntent, platformDetails, media } = dto;

    this.logger.log(`Processing ${publishIntent} for variant ${variantId}, user ${userId}`);

    const canonicalDetails = platformDetails.canonical;
    const mediaDetails = media;

    this.logger.log(`Received media object in DTO: ${JSON.stringify(mediaDetails)}`);

    let cleanedImageUris: string[] = []; // This is used for logging later, can be kept or removed if processedImageUrisForDb is sufficient
    let processedImageUrisForDb: string[] = []; // Initialize here

    if (mediaDetails?.imageUris && Array.isArray(mediaDetails.imageUris)) {
      this.logger.log('Raw imageUris from DTO before cleaning attempt:');
      mediaDetails.imageUris.forEach((uri, index) => {
        this.logger.log(`  [${index}]: "${uri}" (length: ${uri?.length})`);
      });

      // Process imageUris for saving
      processedImageUrisForDb = mediaDetails.imageUris.map((rawUri, index) => {
        this.logger.log(`[ImageCleanDB ${index}] Raw URI (as received by map): \\"${rawUri}\\"`);
        
        let currentUrl = typeof rawUri === 'string' ? rawUri : ''; // Assign rawUri first

        // STEP 1: Aggressively remove trailing semicolon if it's the last char of raw string
        const originalForTrailingSemicolonRemoval = currentUrl;
        if (typeof currentUrl === 'string') { // Ensure it is a string before calling replace
            currentUrl = currentUrl.replace(/;$/, '');
        }
        if (originalForTrailingSemicolonRemoval !== currentUrl) {
            this.logger.log(`[ImageCleanDB ${index}] After initial .replace(/;$/, '') on raw input: \\"${currentUrl}\\"`);
        } else {
            this.logger.log(`[ImageCleanDB ${index}] No change from initial .replace(/;$/, '') on raw input. URL: \\"${currentUrl}\\"`);
        }

        // STEP 2: Trim whitespace
        const originalForTrim = currentUrl;
        if (typeof currentUrl === 'string') { // Ensure it is a string before calling trim
            currentUrl = currentUrl.trim();
        }
        if (originalForTrim !== currentUrl) {
            this.logger.log(`[ImageCleanDB ${index}] After .trim(): \\"${currentUrl}\\" (Length: ${currentUrl.length})`);
        } else {
            this.logger.log(`[ImageCleanDB ${index}] No change from .trim(). URL: \\"${currentUrl}\\" (Length: ${currentUrl.length})`);
        }
        
        // Detailed charCode logging for the end of the (now trimmed and potentially semicolon-stripped) string
        if (currentUrl.length > 0) {
            this.logger.log(`[ImageCleanDB ${index}] Last 5 charCodes for: "${currentUrl}"`);
            for (let i = Math.max(0, currentUrl.length - 5); i < currentUrl.length; i++) {
                this.logger.log(`  Char at ${i}: ${currentUrl.charCodeAt(i)} ('${currentUrl[i]}')`);
            }
        }

        // Step 1: Attempt to extract URL if it matches the specific problematic format like '["some_label"](actual_url_part)'
        const problematicFormatMatch = currentUrl.match(/.*\]\(([^)]*)\)/); // Matches 'anything](URL_PART)'
        if (problematicFormatMatch && problematicFormatMatch[1]) {
          currentUrl = problematicFormatMatch[1].trim();
          this.logger.log(`[ImageCleanDB ${index}] Extracted from problematic format 'anything](URL_PART)': "${currentUrl}"`);
        } else {
          // Fallback: Check for standard Markdown (less likely to be the issue here based on logs but good to keep)
          const markdownMatch = currentUrl.match(/\\\[[^\]]*\\\]\\(([^)]*)\\)/); // Simplified standard markdown: [text](url)
          if (markdownMatch && markdownMatch[1]) { // Group 1 for standard markdown URL
            currentUrl = markdownMatch[1].trim();
            this.logger.log(`[ImageCleanDB ${index}] Extracted from standard Markdown format: "${currentUrl}"`);
          } else {
            this.logger.log(`[ImageCleanDB ${index}] No specific Markdown or problematic format found. Proceeding with URL as is for subsequent cleaning: "${currentUrl}".`);
          }
        }

        // Step 2: Decode URI Components - Applied to potentially extracted URL
        try {
          let decodedUrl = currentUrl;
          // Iteratively decode if there's still '%'
          for (let i = 0; i < 3 && decodedUrl.includes('%'); i++) { 
            decodedUrl = decodeURIComponent(decodedUrl);
          }
          currentUrl = decodedUrl;
          this.logger.log(`[ImageCleanDB ${index}] After decodeURIComponent (iterative): "${currentUrl}"`);
        } catch (e) {
          this.logger.warn(`[ImageCleanDB ${index}] Error decoding URI component for "${currentUrl}": ${e.message}. URL kept as is.`);
          // Keep currentUrl as is if decoding fails
        }
        
        // Step 3: Remove leading/trailing literal double quotes - Applied to potentially extracted AND decoded URL
        currentUrl = currentUrl.replace(/^"|"$/g, '');
        this.logger.log(`[ImageCleanDB ${index}] After quote removal: "${currentUrl}"`);
        
        // Step 4: Final check for http/https prefix
        if (!currentUrl.startsWith('http://') && !currentUrl.startsWith('https://')) {
          this.logger.warn(`[ImageCleanDB ${index}] URL "${currentUrl}" does not start with http(s). May be invalid.`);
        }
        
        this.logger.log(`[ImageCleanDB ${index}] Final URL for DB (before map return): "${currentUrl}", Type: ${typeof currentUrl}, Length: ${currentUrl?.length}`);
        return currentUrl;
      }).filter(uri => {
        const isValid = typeof uri === 'string' && uri.length > 0 && uri.startsWith('http');
        this.logger.log(`[ImageCleanDB Filter] URI: "${uri}", IsValidForFilter: ${isValid}`);
        return isValid;
      });


      // Use processedImageUrisForDb for database operations
      cleanedImageUris = processedImageUrisForDb; // Update this if it's used later, though it's mainly for logging now

      this.logger.log('Cleaned imageUris for DB storage:');
      processedImageUrisForDb.forEach((uri, index) => {
        this.logger.log(`  [DB ${index}]: "${uri}"`);
      });

    } else {
      this.logger.log('No imageUris found in DTO or not an array.');
    }

    // 1. Verify user ownership/existence (optional but recommended)
    const { data: variantCheck, error: checkError } = await supabase
      .from('ProductVariants')
      .select('ProductId')
      .match({ Id: variantId, UserId: userId, ProductId: productId })
      .maybeSingle();

    if (checkError || !variantCheck) {
       this.logger.error(`Variant check failed for ${variantId}, user ${userId}: ${checkError?.message}`);
       throw new NotFoundException('Product variant not found or access denied.');
    }

    // --- START: Update Canonical Data ---
    this.logger.debug(`Updating canonical data for variant ${variantId}`);
    try {
        // Extract primary canonical details from the DTO
        if (!canonicalDetails) {
            this.logger.warn(`Canonical details missing in DTO for variant ${variantId}. Only UpdatedAt will be set.`);
        const updatePayload = {
            UpdatedAt: new Date().toISOString(),
        };
        const { error: updateError } = await supabase
            .from('ProductVariants')
            .update(updatePayload)
            .match({ Id: variantId });
        if (updateError) throw updateError;
        } else {
            const updatePayload: Partial<ProductVariant> = {
                UpdatedAt: new Date().toISOString(),
                Title: canonicalDetails.title,
                Description: canonicalDetails.description,
                Price: canonicalDetails.price,
                CompareAtPrice: canonicalDetails.compareAtPrice,
                // Sku: canonicalDetails.sku, // Assuming SKU might be updated - Handled below
                // Barcode: canonicalDetails.barcode, // Assuming Barcode might be updated - Handled below
                // Weight: canonicalDetails.weight, // Handled below
                // WeightUnit: canonicalDetails.weightUnit, // Handled below
                // Options might need more complex handling if they are structured in platformDetails
                // For now, assuming direct fields like Brand, Condition, Vendor, ProductType are not on ProductVariants directly
                // but could be if your schema evolves or you map them to e.g. a JSONB options field.
            };

            // Conditionally add SKU to updatePayload
            if (canonicalDetails.sku !== "" && canonicalDetails.sku !== undefined) {
                updatePayload.Sku = canonicalDetails.sku;
            } else if (canonicalDetails.sku === "") {
                this.logger.warn(`Received empty SKU for variant ${variantId} from user ${userId}. SKU will not be updated to an empty string to avoid potential unique constraint errors. The existing SKU for this variant will be preserved.`);
            }

            // Conditionally add Barcode to updatePayload
            if (canonicalDetails.barcode !== undefined) {
                updatePayload.Barcode = canonicalDetails.barcode;
            }

            // Conditionally add Weight to updatePayload
            if (canonicalDetails.weight !== undefined) {
                updatePayload.Weight = canonicalDetails.weight;
            }

            // Conditionally add WeightUnit to updatePayload
            if (canonicalDetails.weightUnit !== undefined) {
                updatePayload.WeightUnit = canonicalDetails.weightUnit;
            }

            const { error: updateError } = await supabase
                .from('ProductVariants')
                .update(updatePayload)
                .match({ Id: variantId });
            if (updateError) {
                this.logger.error(`Error updating ProductVariants for ${variantId}: ${updateError.message}`);
                throw updateError;
            }
            this.logger.log(`Successfully updated ProductVariants for ${variantId} with canonical details.`);
        }

        // Update ProductImages based on dto.media (delete existing, add new)
        if (media && processedImageUrisForDb && Array.isArray(processedImageUrisForDb)) { // Check processedImageUrisForDb
            this.logger.log(`Updating ProductImages for variant ${variantId}. Found ${processedImageUrisForDb.length} new images from processed DTO.`);
            // 1. Delete existing images for this variant
            const { error: deleteError } = await supabase
                .from('ProductImages')
                .delete()
                .match({ ProductVariantId: variantId });

            if (deleteError) {
                this.logger.error(`Failed to delete existing images for variant ${variantId}: ${deleteError.message}`);
                // Decide if this is a fatal error or if we can proceed
            }

            // 2. Insert new images (using the processedImageUrisForDb)
            if (processedImageUrisForDb.length > 0) {
                const imagesToInsert = processedImageUrisForDb.map((url, index) => {
                    // The URL here is already cleaned by the new logic above.
                    // The logger.log statements for extension-based cleaning and fallback are removed
                    // as the comprehensive cleaning should handle it.

                    this.logger.log(`[saveOrPublishListing - DB Insert] Using pre-cleaned URL for DB: "${url}"`);

                    return {
                        ProductVariantId: variantId,
                        ImageUrl: url, // Use the comprehensively cleaned URL
                        AltText: canonicalDetails?.title || 'Product image', 
                        Position: index,
                    };
                });

                this.logger.debug(`[saveOrPublishListing] ProductImages to be inserted into DB: ${JSON.stringify(imagesToInsert)}`);

                const { error: insertError } = await supabase
                    .from('ProductImages')
                    .insert(imagesToInsert);

                if (insertError) {
                    this.logger.error(`Failed to insert new images for variant ${variantId}: ${insertError.message}`);
                    // Decide if this is a fatal error
                } else {
                    this.logger.log(`Successfully inserted ${imagesToInsert.length} new images for variant ${variantId}.`);
                }
            }
        } else {
            this.logger.warn(`No media.imageUris found in DTO or processedImageUrisForDb is empty for variant ${variantId}, skipping image update.`);
        }

        await this.activityLogService.logActivity(
           userId,
           'ProductVariant', // EntityType
           variantId, // EntityId
           'UPDATE_CANONICAL_DRAFT', // EventType
           'Success', // Status
           `Saved draft updates for variant ${variantId}.` // Message
        );

    } catch (error) {
        this.logger.error(`Error during update of canonical data for variant ${variantId}: ${error.message}`, error.stack);
        // Check for PostgreSQL unique violation error (code 23505)
        if (error.code === '23505' && error.constraint === 'ProductVariants_UserId_Sku_key') {
            this.logger.warn(`SKU unique constraint violation for variant ${variantId}, user ${userId}. SKU: ${platformDetails?.canonical?.sku}`);
            throw new HttpException(
                {
                    statusCode: HttpStatus.CONFLICT,
                    message: 'The provided SKU is already in use for another of your products.',
                    error: 'Conflict',
                    details: {
                        sku: platformDetails?.canonical?.sku,
                    }
                },
                HttpStatus.CONFLICT,
            );
        }
        // Re-throw other specific HTTP errors if they were thrown by our logic
        if (error instanceof HttpException) {
            throw error;
        }
        // For other database errors or unexpected issues, throw a generic 500
        throw new InternalServerErrorException('Failed to update canonical data for product variant due to a server error.');
    }
    // --- End Update Canonical Data ---
  }

  /**
   * Creates a new product with a variant
   */
  async createProductWithVariant(
      userId: string,
      variantInput: Omit<ProductVariant, 'Id' | 'ProductId' | 'UserId' | 'CreatedAt' | 'UpdatedAt'>
  ): Promise<{ product: SimpleProduct; variant: SimpleProductVariant; analysis?: SimpleAiGeneratedContent }> {
      const supabase = this.getSupabaseClient();
      let productId: string | null = null;
      let variantId: string | null = null;

      try {
          // 1. Create Product
          const { data: productData, error: productError } = await supabase
              .from('Products')
              .insert({
                  UserId: userId,
                  IsArchived: false,
              })
              .select()
              .single();

          if (productError || !productData) {
              throw new InternalServerErrorException('Failed to create product');
          }

          const product = productData as SimpleProduct;
          productId = product.Id;

          // 2. Create Variant
          const { data: variantData, error: variantError } = await supabase
              .from('ProductVariants')
              .insert({
                  ...variantInput,
                  ProductId: productId,
                  UserId: userId,
              })
              .select()
              .single();

          if (variantError || !variantData) {
              throw new InternalServerErrorException('Failed to create product variant');
          }

          const variant = variantData as SimpleProductVariant;
          return { product, variant };

      } catch (error) {
          // Cleanup if needed
          if (productId) {
              await supabase.from('Products').delete().match({ Id: productId });
          }
          throw error;
      }
  }

  /**
   * Gets a product and its variants by ID
   */
  async getProduct(productId: string, userId: string): Promise<{ product: SimpleProduct; variants: SimpleProductVariant[] }> {
      const supabase = this.getSupabaseClient();

      // Get product
      const { data: product, error: productError } = await supabase
          .from('Products')
          .select('*')
          .match({ Id: productId, UserId: userId })
          .single();

      if (productError || !product) {
          throw new NotFoundException(`Product ${productId} not found`);
      }

      // Get variants
      const { data: variants, error: variantsError } = await supabase
          .from('ProductVariants')
          .select('*')
          .match({ ProductId: productId, UserId: userId });

      if (variantsError) {
          throw new InternalServerErrorException('Failed to fetch product variants');
      }

      return {
          product: product as SimpleProduct,
          variants: variants as SimpleProductVariant[]
      };
  }

  /**
   * Example: Queue a product sync job using the dynamic queue manager
   */
  async queueProductSyncJob(productId: string, userId: string) {
    const jobData = { type: 'product-sync', productId, userId, timestamp: Date.now() };
    await QueueManager.enqueueJob(jobData);
  }

  /**
   * Checks if a given SKU is unique for a specific user.
   */
  async isSkuUniqueForUser(userId: string, sku: string): Promise<boolean> {
    const client = this.getSupabaseClient();
    const { data, error } = await client
      .from('ProductVariants')
      .select('Id')
      .eq('UserId', userId)
      .eq('Sku', sku)
      .maybeSingle();

    if (error) {
      this.logger.error(`Error checking SKU uniqueness for user ${userId}, SKU ${sku}: ${error.message}`);
      // Depending on policy, you might want to throw or return false (conservative)
      throw new InternalServerErrorException('Error checking SKU uniqueness');
    }
    return data === null; // SKU is unique if no record is found
  }

  public determineShopifyProductOptions(variants: ProductVariant[]): { name: string; values: string[] }[] {
    if (!variants || variants.length === 0) {
      return [];
    }

    const optionsMap = new Map<string, Set<string>>();

    variants.forEach(variant => {
      if (variant.Options && typeof variant.Options === 'object') {
        const variantOptions = variant.Options as Record<string, string>; 
        Object.entries(variantOptions).forEach(([optionName, optionValue]) => {
          if (optionName.toLowerCase() === 'shopify') return;
          if (optionName.toLowerCase() === 'title') return; // Avoid treating a default "Title" option from canonical as a user-defined one here

          if (!optionsMap.has(optionName)) {
            optionsMap.set(optionName, new Set<string>());
          }
          if (typeof optionValue === 'string') {
            optionsMap.get(optionName)!.add(optionValue);
          } else if (optionValue !== null && optionValue !== undefined) {
            optionsMap.get(optionName)!.add(String(optionValue));
          }
        });
      }
    });
    
    const shopifyOptions: { name: string; values: string[] }[] = [];
    let count = 0;
    for (const [name, valuesSet] of optionsMap.entries()) {
      if (count < 3) {
        shopifyOptions.push({ name, values: Array.from(valuesSet) });
        count++;
      } else {
        this.logger.warn(`Product has more than 3 options. Shopify only supports up to 3. Option "${name}" will be ignored.`);
        break; 
      }
    }
    
    // If NO user-defined options were found from variant.Options, 
    // AND variants exist, Shopify expects productOptions to be defined.
    // For a single variant product, it's common to use "Title" as the option name 
    // and the variant's title as the value.
    if (shopifyOptions.length === 0 && variants.length > 0) {
        const firstVariantTitle = variants[0].Title;
        if (firstVariantTitle) {
            this.logger.log(`No user-defined options found. Defaulting to "Title" option for Shopify using the first variant's title: "${firstVariantTitle}".`);
            // Collect all unique titles if there are multiple variants and no other options, up to Shopify's limit for option values.
            const allTitles = Array.from(new Set(variants.map(v => v.Title).filter(t => t) as string[]));
            const titleValues = variants.length > 1 ? allTitles.slice(0, 100) : [firstVariantTitle]; // Shopify limit: 100 values per option
            
            if (titleValues.length > 0) {
                 shopifyOptions.push({ name: "Title", values: titleValues });
            } else {
                // Fallback if no titles are available, though unlikely if variants exist
                this.logger.warn('No user-defined options and no variant titles available to create default "Title" option for Shopify.');
                shopifyOptions.push({ name: "Title", values: ["Default Title"] }); // Shopify requires options if variants are present
            }
        } else {
             this.logger.warn('First variant has no title. Defaulting Shopify option to "Title" : ["Default Title"]. Product creation might behave unexpectedly.');
             shopifyOptions.push({ name: "Title", values: ["Default Title"] }); // Shopify requires options if variants are present
        }
    }

    return shopifyOptions;
  }
}