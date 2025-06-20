import { Injectable, InternalServerErrorException, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Groq from 'groq-sdk'; // Import Groq SDK
// Try importing the specific content part type
import { ChatCompletionContentPart } from 'groq-sdk/resources/chat/completions';
import { SerpApiLensResponse, VisualMatch } from '../image-recognition/image-recognition.service'; // Keep using these interfaces

// Define richer expected output structure based on platform keys
// Aligns more closely with frontend needs and user-provided structure
export interface GeneratedPlatformSpecificDetails {
  title?: string;
  description?: string; // Should be detailed, potentially HTML or Markdown if requested
  price?: number; // Primary price suggestion in USD
  compareAtPrice?: number; // Optional compare-at price in USD
  categorySuggestion?: string; // Text suggestion (e.g., "Men's T-shirts", "Home Decor > Vases") - Not an ID
  tags?: string[] | string; // Array preferred, but handle string
  weight?: number;
  weightUnit?: string; // e.g., "kg", "lb"
  // Common fields expanded
  brand?: string;
  condition?: string; // e.g., "New", "Used - Like New" (Suggest based on image/context)
  // Platform-specific suggestions
  // Shopify
  status?: 'active' | 'draft' | 'archived'; // Suggest 'active' or 'draft'
  vendor?: string;
  productType?: string; // Shopify's own categorization
  // Square
  locations?: string; // Suggest "All Available Locations" or similar placeholder
  gtin?: string; // Suggest extracting from visual match barcode if possible
  // eBay
  listingFormat?: 'FixedPrice' | 'Auction'; // Suggest 'FixedPrice' generally
  duration?: string; // Suggest 'GTC' (Good 'Til Canceled) for FixedPrice
  dispatchTime?: string; // Suggest a reasonable default like "1 business day"
  returnPolicy?: string; // Suggest a basic return policy text
  shippingService?: string; // Suggest a common domestic service like "USPS Ground Advantage"
  itemLocationPostalCode?: string; // Try to infer if possible, otherwise leave null
  itemSpecifics?: { [key: string]: string }; // Suggest common specifics like Size, Color, Material based on image/context
  // Amazon
  bullet_points?: string[]; // Suggest 3-5 key feature bullet points
  search_terms?: string[]; // Suggest relevant keywords
  // amazonProductType?: string; // Renamed from productType to avoid conflict with Shopify's (This is the crucial Amazon category)
  productIdType?: 'UPC' | 'EAN' | 'GTIN' | 'ASIN'; // Suggest based on visual match barcode or if it looks like an existing product
  // Facebook Marketplace
  availability?: 'in stock' | 'limited stock' | 'out of stock'; // Suggest 'in stock'
  // Allow for other potential fields
  [key: string]: any;
}

export interface GeneratedDetails {
  [platform: string]: GeneratedPlatformSpecificDetails; // Use the more detailed interface
}

@Injectable()
export class AiGenerationService {
  private readonly logger = new Logger(AiGenerationService.name);
  private groq: Groq | null = null; // Groq client instance

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('GROQ_API_KEY');
    if (apiKey) {
      this.groq = new Groq({ apiKey }); // Initialize Groq client
      this.logger.log('Groq client initialized.');
    } else {
      this.logger.error('GROQ_API_KEY is not configured. AI Generation Service disabled.');
    }
  }

  // Safety settings might not be directly applicable/configurable in Groq SDK in the same way
  // Consult Groq documentation if specific safety filtering is needed.

  async generateProductDetails(
    imageUrls: string[], // Keep imageUrls for potential future multi-image analysis
    coverImageUrl: string,
    targetPlatforms: string[],
    selectedMatchContext?: { visual_matches: VisualMatch[] } | null,
  ): Promise<GeneratedDetails | null> {
    if (!this.groq) {
      this.logger.warn('Groq client not initialized. Cannot generate product details.');
        return null;
    }

    try {
      this.logger.log(`Generating product details for platforms: ${targetPlatforms.join(', ')}`);
      
      // Build context from visual matches if available
      let visualMatchContext = '';
      if (selectedMatchContext?.visual_matches && selectedMatchContext.visual_matches.length > 0) {
        const matches = selectedMatchContext.visual_matches.slice(0, 3); // Use top 3 matches
        visualMatchContext = `\n\nVisual Match Context (similar products found online):\n${matches.map((match, index) => 
          `${index + 1}. Title: "${match.title}"\n   Price: $${match.price?.value || 'N/A'}\n   Source: ${match.source}`
        ).join('\n')}`;
      }

      const prompt = `You are an expert e-commerce product listing specialist. Analyze this product image and generate optimized details for the specified platforms.

Image URL: ${coverImageUrl}${visualMatchContext}

Target Platforms: ${targetPlatforms.join(', ')}

Generate a JSON response with platform-specific details. For each platform, provide:

REQUIRED FIELDS:
- title: Compelling, SEO-optimized product title (50-60 chars for most platforms)
- description: Detailed, engaging product description (HTML formatted for Shopify)
- price: Suggested retail price in USD
- categorySuggestion: Platform-appropriate category path
- tags: Array of relevant keywords/tags
- brand: Product brand if identifiable
- condition: Product condition (New, Used, Refurbished, etc.)

PLATFORM-SPECIFIC FIELDS:
For Shopify: vendor, productType, status (active/draft)
For Amazon: bullet_points (array), search_terms (array), productIdType
For eBay: listingFormat, duration, dispatchTime, returnPolicy
For Square: locations, gtin
For Facebook: availability

Use this exact JSON structure:
{
  "shopify": { "title": "...", "description": "...", "price": 29.99, ... },
  "amazon": { "title": "...", "description": "...", "price": 29.99, ... },
  "ebay": { "title": "...", "description": "...", "price": 29.99, ... }
}

Focus on accuracy, SEO optimization, and platform best practices. If visual matches are provided, use them to inform pricing and categorization but ensure your suggestions are competitive and realistic.`;

      const completion = await this.groq.chat.completions.create({
        model: 'deepseek-r1-distill-llama-70b',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: prompt,
              },
              {
                type: 'image_url',
                image_url: {
                  url: coverImageUrl,
                },
              },
            ] as ChatCompletionContentPart[],
          },
        ],
        temperature: 0.6,
        max_tokens: 2000,
      });

      const responseText = completion.choices[0]?.message?.content;
      if (!responseText) {
        this.logger.warn('No response content from Groq API');
        return null;
      }

      // Parse JSON response
      try {
        const generatedDetails = JSON.parse(responseText) as GeneratedDetails;
        this.logger.log('Successfully generated product details using AI');
        return generatedDetails;
      } catch (parseError) {
        this.logger.error(`Failed to parse AI response as JSON: ${parseError.message}`);
        this.logger.debug(`Raw AI response: ${responseText}`);
        return null;
      }
    } catch (error) {
      this.logger.error(`Error generating product details: ${error.message}`, error.stack);
      return null;
    }
  }

  /**
   * AI-powered product matching by title similarity
   * Uses DeepSeek R1 Distill Llama 70B to intelligently match products when SKU matching fails
   */
  async findProductMatches(
    platformProducts: Array<{ id: string; title: string; sku?: string; price?: number }>,
    canonicalProducts: Array<{ id: string; title: string; sku?: string; price?: number }>,
    threshold: number = 0.8
  ): Promise<Array<{ platformProduct: any; canonicalProduct: any; confidence: number; reason: string }>> {
    if (!this.groq) {
      this.logger.warn('Groq client not initialized. Cannot perform AI product matching.');
      return [];
    }

    if (platformProducts.length === 0 || canonicalProducts.length === 0) {
      return [];
    }

    try {
      this.logger.log(`AI matching ${platformProducts.length} platform products with ${canonicalProducts.length} canonical products`);

      // Process in batches to avoid token limits
      const batchSize = 10;
      const allMatches: Array<{ platformProduct: any; canonicalProduct: any; confidence: number; reason: string }> = [];

      for (let i = 0; i < platformProducts.length; i += batchSize) {
        const batch = platformProducts.slice(i, i + batchSize);
        
        const prompt = `You are an expert product matching system. Your task is to find the best matches between platform products and canonical products based on title similarity, considering context clues like price, brand, and product type.

PLATFORM PRODUCTS TO MATCH:
${batch.map((p, idx) => `${idx + 1}. ID: ${p.id}, Title: "${p.title}", SKU: ${p.sku || 'N/A'}, Price: $${p.price || 'N/A'}`).join('\n')}

CANONICAL PRODUCTS (potential matches):
${canonicalProducts.map((c, idx) => `${idx + 1}. ID: ${c.id}, Title: "${c.title}", SKU: ${c.sku || 'N/A'}, Price: $${c.price || 'N/A'}`).join('\n')}

For each platform product, find the best matching canonical product(s) if any exist. Consider:
- Title similarity (most important)
- Brand/manufacturer mentions
- Product type/category
- Price reasonableness (should be in similar range)
- Model numbers or specific identifiers

Return ONLY a JSON array with this exact structure:
[
  {
    "platformProductId": "platform_id_here",
    "canonicalProductId": "canonical_id_here", 
    "confidence": 0.95,
    "reason": "Exact title match with same brand and similar price"
  }
]

Only include matches with confidence >= ${threshold}. If no good match exists for a platform product, don't include it in the response.

IMPORTANT: Return ONLY the JSON array, no other text.`;

        const completion = await this.groq.chat.completions.create({
          model: 'deepseek-r1-distill-llama-70b',
        messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
          temperature: 0.3, // Lower temperature for more consistent matching
          max_tokens: 1500,
        });

        const responseText = completion.choices[0]?.message?.content?.trim();
        if (!responseText) {
          this.logger.warn(`No response for batch ${i / batchSize + 1}`);
          continue;
        }

        try {
          const batchMatches = JSON.parse(responseText);
          if (Array.isArray(batchMatches)) {
            // Map IDs back to actual objects
            for (const match of batchMatches) {
              const platformProduct = batch.find(p => p.id === match.platformProductId);
              const canonicalProduct = canonicalProducts.find(c => c.id === match.canonicalProductId);
              
              if (platformProduct && canonicalProduct && match.confidence >= threshold) {
                allMatches.push({
                  platformProduct,
                  canonicalProduct,
                  confidence: match.confidence,
                  reason: match.reason
                });
              }
            }
          }
        } catch (parseError) {
          this.logger.error(`Failed to parse AI matching response for batch ${i / batchSize + 1}: ${parseError.message}`);
          this.logger.debug(`Raw response: ${responseText}`);
        }

        // Small delay between batches to respect rate limits
        if (i + batchSize < platformProducts.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      this.logger.log(`AI matching completed. Found ${allMatches.length} matches above ${threshold} confidence threshold`);
      return allMatches.sort((a, b) => b.confidence - a.confidence); // Sort by confidence descending

    } catch (error) {
      this.logger.error(`Error in AI product matching: ${error.message}`, error.stack);
      return [];
    }
  }
}

