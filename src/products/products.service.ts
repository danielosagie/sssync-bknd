import { Injectable, Logger, NotFoundException, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseService } from '../common/supabase.service';
import { ImageRecognitionService, SerpApiLensResponse, VisualMatch } from './image-recognition/image-recognition.service';
import { AiGenerationService, GeneratedDetails } from './ai-generation/ai-generation.service';

// Define types for your database tables based on sssync-db.md
// Example (you might need more specific types)
interface Product {
  Id: string; // uuid
  UserId: string; // uuid
  IsArchived: boolean;
  CreatedAt: string;
  UpdatedAt: string;
}

interface ProductVariant {
   Id: string;
   ProductId: string;
   UserId: string;
   Sku?: string; // Auto-generate later?
   // ... other fields like Title, Description, Price etc. will come from AI generation
}

interface ProductImage {
    Id: string;
    ProductVariantId: string;
    ImageUrl: string;
    Position: number; // 0 for cover photo?
}

interface AiGeneratedContentRecord {
    Id: string;
    ProductId: string;
    ContentType: string; // e.g., 'title', 'description', 'tags', 'full_listing_json'
    SourceApi: string; // e.g., 'gemini-1.5-flash'
    Prompt?: string;
    GeneratedText: string; // Store the generated text/JSON string
    Metadata?: Record<string, any>; // Store platform, etc.
    IsActive: boolean;
    CreatedAt: string;
}


@Injectable()
export class ProductsService {
  private supabase: SupabaseClient;
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly imageRecognitionService: ImageRecognitionService,
    private readonly aiGenerationService: AiGenerationService,
  ) {
    this.supabase = this.supabaseService.getClient();
  }

  // Endpoint 1 Logic: Analyze Images
  async analyzeImages(
    userId: string,
    imageUrls: string[],
    selectedPlatforms: string[], // Although not used by recognition, might be useful context later
  ): Promise<SerpApiLensResponse | null> {
    if (!imageUrls || imageUrls.length === 0) {
      throw new BadRequestException('At least one image URL is required.');
    }
    // Assume the first image is the primary one for analysis for now
    const primaryImageUrl = imageUrls[0];
    this.logger.log(`Service: Analyzing image ${primaryImageUrl} for user ${userId}`);
    return this.imageRecognitionService.analyzeImageByUrl(primaryImageUrl);
  }

  // Endpoint 2 Logic: Generate Details
  async generateDetails(
    userId: string,
    imageUrls: string[],
    coverImageIndex: number,
    selectedPlatforms: string[],
    lensResponse?: SerpApiLensResponse | null,
  ): Promise<{ productId: string; variantId: string; generatedDetails: GeneratedDetails | null }> {
    if (!imageUrls || imageUrls.length === 0) {
      throw new BadRequestException('At least one image URL is required.');
    }
    if (coverImageIndex < 0 || coverImageIndex >= imageUrls.length) {
        throw new BadRequestException('Invalid cover image index.');
    }
     if (!selectedPlatforms || selectedPlatforms.length === 0) {
      throw new BadRequestException('At least one target platform is required.');
    }

    this.logger.log(`Service: Generating details for user ${userId}, platforms: ${selectedPlatforms.join(', ')}`);

    // 1. Call AI Generation Service with updated arguments
    const coverImageUrl = imageUrls[coverImageIndex];
    const generatedDetails = await this.aiGenerationService.generateProductDetails(
      imageUrls,
      coverImageUrl,
      selectedPlatforms,
      lensResponse,
    );

     if (!generatedDetails) {
         this.logger.warn(`AI Generation returned null for user ${userId}`);
         // Decide if you still want to create a draft product
         // For now, let's throw or return an indicator of failure
          throw new InternalServerErrorException('Failed to generate product details from AI.');
     }

    // 2. Create Draft Product and Variant in DB
    // This requires transaction handling ideally
    const { data: product, error: productError } = await this.supabase
      .from('Products')
      .insert({ UserId: userId })
      .select()
      .single();

    if (productError || !product) {
      this.logger.error(`Failed to create product entry for user ${userId}: ${productError?.message}`, productError);
      throw new InternalServerErrorException('Failed to save draft product.');
    }
    const productId = product.Id;

    // Create a default variant linked to the product
     const { data: variant, error: variantError } = await this.supabase
      .from('ProductVariants')
      .insert({
          ProductId: productId,
          UserId: userId,
          Title: 'Draft Product', // Placeholder Title
          Description: 'Pending details...', // Placeholder Desc
          Price: 0, // Placeholder Price
          // Sku can be generated later
       })
      .select()
      .single();

     if (variantError || !variant) {
       this.logger.error(`Failed to create product variant for product ${productId}: ${variantError?.message}`, variantError);
       // Consider cleanup: delete the product created above
       await this.supabase.from('Products').delete().match({ Id: productId });
       throw new InternalServerErrorException('Failed to save draft product variant.');
     }
     const variantId = variant.Id;

    // 3. Save Images to DB, linking to the variant
    const imageInserts = imageUrls.map((url, index) => ({
        ProductVariantId: variantId,
        ImageUrl: url,
        Position: index === coverImageIndex ? 0 : index + 1, // Convention: 0 is cover
    }));

    const { error: imageError } = await this.supabase
        .from('ProductImages')
        .insert(imageInserts);

    if (imageError) {
         this.logger.error(`Failed to save product images for variant ${variantId}: ${imageError.message}`, imageError);
         // Consider cleanup: delete product/variant
         // For simplicity, logging error but proceeding for now
    }

    // 4. Save Generated AI Content to DB
    const aiContentInserts: Omit<AiGeneratedContentRecord, 'Id' | 'CreatedAt'>[] = [];
    for (const platform of Object.keys(generatedDetails)) {
        aiContentInserts.push({
            ProductId: productId, // Link AI content to the Product
            ContentType: 'full_listing_json', // Store the whole JSON for the platform
            SourceApi: 'gemini-1.5-flash', // Or dynamically get model name
            // Prompt: prompt used (might be long, consider storing if needed)
            GeneratedText: JSON.stringify(generatedDetails[platform]),
            Metadata: { platform: platform },
            IsActive: true, // Mark this as the current active generation
        });
        // Optionally save individual fields like title/description separately if needed for indexing/search
    }

     const { error: aiError } = await this.supabase
        .from('AiGeneratedContent')
        .insert(aiContentInserts);

     if (aiError) {
         this.logger.error(`Failed to save AI generated content for product ${productId}: ${aiError.message}`, aiError);
          // Consider cleanup or logging
     }

    this.logger.log(`Successfully generated details and created draft product ${productId} / variant ${variantId}`);

    // Return the IDs and the generated details for the frontend form
    return { productId, variantId, generatedDetails };
  }

   // --- TODO: Add method for saving edited data (Step 4/5 from frontend) ---
   // async saveListingDetails(userId: string, variantId: string, formData: any) { ... }

   // --- TODO: Add method for publishing to platforms (Step 5 from frontend) ---
   // async publishListing(userId: string, variantId: string, targetPlatforms: string[]) { ... }

}
