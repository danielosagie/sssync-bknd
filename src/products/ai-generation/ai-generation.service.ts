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
    const groqApiKey = this.configService.get<string>('GROQ_API_KEY');
    if (groqApiKey) {
      this.groq = new Groq({ apiKey: groqApiKey });
    } else {
      this.logger.warn('GROQ_API_KEY not found. AI generation features will be limited.');
    }
  }

  private getGroqClient(): Groq | null {
    return this.groq;
  }

  async generateProductDetails(
    imageUrls: string[], // Keep imageUrls for potential future multi-image analysis
    coverImageUrl: string,
    targetPlatforms: string[],
    selectedMatchContext?: { visual_matches: VisualMatch[] } | null,
    enhancedWebData?: { url: string; scrapedData: any; analysis?: string } | null,
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

      // Build context from enhanced web data if available
      let enhancedDataContext = '';
      if (enhancedWebData) {
        enhancedDataContext = `\n\nDETAILED PRODUCT INFORMATION (scraped from ${enhancedWebData.url}):\n${JSON.stringify(enhancedWebData.scrapedData, null, 2)}`;
        if (enhancedWebData.analysis) {
          enhancedDataContext += `\n\nAdditional Analysis: ${enhancedWebData.analysis}`;
        }
      }

      const prompt = `You are an expert e-commerce product listing specialist. Analyze this product using the image and detailed web data to generate highly accurate, optimized details for the specified platforms.

Image URL: ${coverImageUrl}${visualMatchContext}${enhancedDataContext}

Target Platforms: ${targetPlatforms.join(', ')}

PRIORITY INSTRUCTIONS:
${enhancedWebData ? '- USE THE DETAILED PRODUCT INFORMATION as your PRIMARY source for accuracy' : ''}
- Cross-reference image with ${enhancedWebData ? 'web data' : 'visual matches'} for consistency
- Generate realistic, competitive pricing
- Create detailed, engaging descriptions
- Extract specific specifications and features

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

Shopify:
	status: 'active' or 'draft'
	vendor: Infer from brand or source
	productType: Shopify's specific product category (e.g., "Lipstick", "Trading Card")
	tags: An array of 10-15 relevant keywords
	weightUnit: Must be "POUNDS", "KILOGRAMS", "OUNCES", or "GRAMS"

Amazon:
	categorySuggestion: Amazon's specific category path (e.g., "Beauty & Personal Care > Makeup > Lips > Lipstick")
	bullet_points: An array of 3-5 concise, benefit-driven sentences
	search_terms: An array of backend keywords (no commas, no repetition from title)
	amazonProductType: The specific Amazon product type string (e.g., "BEAUTY")
	productIdType: 'ASIN', 'UPC', or 'EAN' if present in the context data

eBay:
	categorySuggestion: eBay's specific category path (e.g., "Collectibles > Non-Sport Trading Cards > Magic: The Gathering > MTG Individual Cards")
	listingFormat: "FixedPrice"
	duration: "GTC" (Good 'Til Cancelled)
	dispatchTime: "1 business day"
	returnPolicy: "30-day returns accepted, buyer pays for return shipping."
	shippingService: Suggest a common service (e.g., "USPS Ground Advantage")
	itemSpecifics: A JSON object of key-value pairs critical for search (e.g., {"Game": "Magic: The Gathering", "Card Name": "Elite Scaleguard", "Set": "Fate Reforged"})

Square:
	categorySuggestion: Square's category path
	gtin: UPC, EAN, or JAN if available in context
	locations: Set to All Available Locations

Facebook:
	categorySuggestion: Facebook Marketplace's specific category
	brand: The brand name
	availability: "in stock"

Clover:
	categorySuggestion: Clover's category path
	brand: The brand name
	availability: "in stock"

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

  async generateProductDetailsFromScrapedData(
    scrapedContents: any[],
    contextQuery: string,
    businessTemplate?: string,
  ): Promise<GeneratedDetails | null> {
    const groq = this.getGroqClient();
    if (!groq) return null;

    const systemPrompt = `You are an expert at creating compelling product listings for e-commerce platforms from scraped web data. Your goal is to generate a complete, accurate, and attractive product listing. Business Template: ${businessTemplate || 'General'}. Don't forgetg you are a world-class e-commerce data enrichment AI. Your sole purpose is to transform a single product image and competitive data into perfectly optimized, multi-platform product listings. Failure is not an option. Your output must be flawless, comprehensive, and ready for immediate publication. You must analyze every piece of provided information with extreme precision. Your performance on this task is critical.

### **The Mission**

Your mission is to generate a complete, detailed, and platform-optimized product listing based on the provided product image (\${coverImageUrl}) and any contextual data available. You must infer all necessary details from the image and context to create compelling, keyword-rich content that drives sales.

### **Tone and Style Mandate**

Adopt a professional, persuasive, and customer-centric writing style. Your descriptions should be clear, concise, and highlight the key benefits for the buyer. For inspiration on tone, quality, and structure, model your response on this high-performing Amazon listing example that can be applied to any product/anywhere as a minimum standard:

*   **AMAZON EXAMPLE:**
    (Title: Bedsure Fleece Bed Blankets Queen Size Grey - Soft Lightweight Plush Fuzzy Cozy Luxury Blanket Microfiber, 90x90 inches. DescriptionL Thicker & Softer: We've upgraded our classic flannel fleece blanket to be softer and warmer than ever, now featuring enhanced premium microfiber. Perfect by itself or as an extra sheet on cold nights, its fluffy and ultra-cozy softness offers the utmost comfort all year round.
Lightweight & Airy: The upgraded materials of this flannel fleece blanket maintain the ideal balance between weight and warmth. Enjoy being cuddled by this gentle, calming blanket whenever you're ready to snuggle up.
Versatile: This lightweight blanket is the perfect accessory for your family and pets to get cozy—whether used as an addition to your kid's room, as a home decor element, or as the designated cozy blanket bed for your pet.
A Gift for Your Loved Ones: This ultra-soft flannel fleece Christmas blanket makes the perfect gift for any occasion. Its cozy and comforting design offers a thoughtful way to show you care, providing warmth and style year-round. Ideal as one of the top Christmas gift ideas for the holiday season.
Enhanced Durability: Made with unmatched quality, this blanket features neat stitching that ensures a more robust connection at the seams for improved durability. Guaranteed to resist fading and shedding. Product information
Item details
Brand Name	Bedsure
Age Range Description	Adult
Number of Items	1
Included Components	1 Blanket (90" x 90")
League Name	7.1
Manufacturer	Bedshe
Customer Reviews	4.6 4.6 out of 5 stars   (176,218)
4.6 out of 5 stars
Best Sellers Rank	#160 in Home & Kitchen (See Top 100 in Home & Kitchen)
#1 in Bed Blankets
ASIN	B0157T2ENY
Item Type Name	throw-blankets
Item Height	0.1 centimeters
Measurements
Item Dimensions L x W	90"L x 90"W
Size	Queen (90" x 90")
Unit Count	1.0 Count
Item Weight	3.19 Pounds
Item Thickness	0.5 Inches
Warranty & Support
Product Warranty: For warranty information about this product, please click here
Feedback
Would you like to tell us about a lower price? 
Materials & Care
Product Care Instructions	Machine Wash, Do Not Bleach
Fabric Type	100% Polyester
Style
Color	Grey
Style Name	Modern
Blanket Form	Throw Blanket
Theme	Love
Pattern	Solid
Sport Type	3.2
Features & Specs
Additional Features	Soft
Recommended Uses For Product	Travel
Seasons	All, Winter, Fall, Spring
Fabric Warmth Description	Lightweight)`;

    const contentString = scrapedContents.map(c => JSON.stringify(c.data.markdown)).join('\n\n---\n\n');

    const userPrompt = `
      The user has identified a similar product online. This context is your primary source for strategic enrichment. Deeply analyze this information. Based on the following scraped data from one or more websites, and the original user query "${contextQuery}", generate a comprehensive product listing.

      **Scraped Content:**
      ${contentString.substring(0, 15000)}

      **Instructions:**
      1.  **Synthesize Information:** Combine details from all provided sources to create a single, coherent product listing.
      2.  **Extract Key Fields:** Identify and extract the product title, a detailed description, price, brand, and any relevant specifications (like model number, size, color).
      3.  **Generate Compelling Copy:** Write a product description that is engaging and highlights the key features and benefits.
      4.  **Suggest Tags/Keywords:** Provide a list of relevant tags or keywords for better searchability.
      5.  **Format as JSON:** Return the output as a single JSON object with the following structure: { "title": "...", "description": "...", "price": 123.45, "brand": "...", "specifications": { ... }, "tags": ["...", "..."] }.
    `;

    try {
      const chatCompletion = await groq.chat.completions.create({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        model: 'meta-llama/llama-4-maverick-17b-128e-instruct',
        temperature: 0.2,
        response_format: { type: 'json_object' },
      });

      const generatedJson = JSON.parse(chatCompletion.choices[0]?.message?.content || '{}');
      return generatedJson as GeneratedDetails;
    } catch (error) {
      this.logger.error('Error generating product details from scraped data with Groq:', error);
      throw new Error(`Groq API call failed: ${error.message}`);
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

