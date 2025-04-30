import { Injectable, Logger, NotFoundException, BadRequestException, InternalServerErrorException, HttpException } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseService } from '../common/supabase.service';
import { ImageRecognitionService, SerpApiLensResponse, VisualMatch } from './image-recognition/image-recognition.service';
import { AiGenerationService, GeneratedDetails } from './ai-generation/ai-generation.service';
import { ConfigService } from '@nestjs/config';
import * as SerpApiClient from 'google-search-results-nodejs';

// Define simple interfaces based on DB schema until DTOs are created
interface SimpleProduct {
  Id: string;
  UserId: string;
  IsArchived: boolean;
  CreatedAt: string;
  UpdatedAt: string;
}

interface SimpleProductVariant {
   Id: string;
   ProductId: string;
   UserId: string;
   Sku: string;
   Title: string;
   Description: string | null;
   Price: number; // Use number for decimal
   CreatedAt: string;
   UpdatedAt: string;
   // Add other fields from sssync-db.md if needed immediately
}

interface SimpleAiGeneratedContent {
    Id: string;
    ProductId: string;
    ContentType: string;
    SourceApi: string;
    GeneratedText: string;
    Metadata?: any;
    IsActive: boolean;
    CreatedAt: string;
}

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);
  private readonly serpApi: SerpApiClient.GoogleSearch;

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly imageRecognitionService: ImageRecognitionService,
    private readonly aiGenerationService: AiGenerationService,
    private readonly configService: ConfigService,
  ) {
    this.logger.log('ProductsService Constructor called.'); // Log entry
    const serpApiKey = this.configService.get<string>('SERPAPI_KEY');
    if (!serpApiKey) {
        this.logger.warn('SERPAPI_KEY is not configured. Product analysis will be disabled.');
    } else {
        this.serpApi = new SerpApiClient.GoogleSearch(serpApiKey);
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
    this.logger.log(`Starting product analysis and draft creation for user ${userId} with image URL.`);

    let analysisResultJson: SerpApiLensResponse | null = null;
    let productId: string | null = null;
    let variantId: string | null = null;
    let aiContentId: string | null = null;

    let product: SimpleProduct | null = null;
    let variant: SimpleProductVariant | null = null;
    let analysis: SimpleAiGeneratedContent | null = null;
    let decrementSucceeded = false; // Flag to track decrement success

    try {
      // 1. Analyze Image with SerpApi Lens (if configured)
      if (this.serpApi) {
         this.logger.debug(`Analyzing image with SerpApi Lens: ${imageUrl}`);
         analysisResultJson = await new Promise<SerpApiLensResponse>((resolve, reject) => {
             this.serpApi.json({
                 engine: "google_lens",
                 url: imageUrl,
                 hl: "en", // Optional: language
                 gl: "us", // Optional: country
             }, (result) => {
                 if (result.error) {
                    this.logger.error(`SerpApi Lens analysis failed: ${result.error}`);
                    // Resolve with the error structure instead of rejecting immediately,
                    // so we can still potentially save the product draft.
                    resolve(result);
                 } else {
                    this.logger.log(`SerpApi Lens analysis successful.`);
                    resolve(result);
                 }
             });
             // Note: The nodejs client library might not have built-in timeout/error handling
             // on the request itself beyond the callback logic. Consider adding external timeout.
         });
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

        // 4. Store Analysis Results (if analysis was performed and successful) using Supabase
        if (analysisResultJson && !analysisResultJson.error) {
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
        } else if (analysisResultJson?.error) {
           this.logger.warn(`Skipping storage of AI analysis due to error during analysis for product ${productId}.`);
        }

        // --- >>> 5. Decrement Usage Count via RPC <<< ---
        this.logger.debug(`Attempting to decrement AiScans for user ${userId} via RPC.`);
        const { data: rpcData, error: rpcError } = await supabase
            .rpc('decrement_ai_scans', { target_user_id: userId }); // Pass userId to the function

        if (rpcError) {
             // Log error but maybe don't fail the whole request? Depends on policy.
             // If the RPC fails, the user got the feature but the count wasn't decremented.
             this.logger.error(`Error calling decrement_ai_scans RPC for user ${userId}: ${rpcError.message}`, rpcError);
             // Decide if you should throw an error here or just log it.
             // throw new InternalServerErrorException('Failed to update usage count.');
        } else if (rpcData === true) {
             // RPC function returned true, meaning decrement was successful
             decrementSucceeded = true;
             this.logger.log(`Successfully decremented AiScans for user ${userId}.`);
        } else {
             // RPC function returned false (or null/unexpected), meaning decrement failed (likely hit limit between guard check and now)
             this.logger.warn(`Decrement_ai_scans RPC returned false for user ${userId}. Limit likely hit concurrently.`);
             // If strict enforcement is needed, you might throw an error here too.
             // throw new HttpException('Usage limit reached just before finalizing', HttpStatus.TOO_MANY_REQUESTS);
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

     Object.entries(generatedDetails).forEach(([platform, details], index) => {
         aiContentInserts.push({
             ProductId: productId,
             ContentType: 'groq_maverick_details', // Specific content type
             SourceApi: 'groq-maverick', // Be specific
             GeneratedText: JSON.stringify(details),
             Metadata: { platform: platform.toLowerCase(), selectedMatch: selectedMatch ?? null },
             IsActive: true, // Active generated content
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

}

