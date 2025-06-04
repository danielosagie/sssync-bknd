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
        this.logger.warn('Cannot generate details: Groq API key is missing.');
        return null;
    }

    // --- Use the Maverick model ---
    const model = 'meta-llama/llama-4-maverick-17b-128e-instruct';

    // --- Construct the Prompt Text for Groq ---
    let promptText = `You are an expert e-commerce data enrichment assistant specializing in creating compelling and platform-optimized product listings. Analyze the product shown in the provided image (${coverImageUrl}). Use the provided context to generate the best possible product details for the following platforms but also follow this tone of product listing writing at a minimum: (AMAZON EXAMPLE: (Title: Bedsure Fleece Bed Blankets Queen Size Grey - Soft Lightweight Plush Fuzzy Cozy Luxury Blanket Microfiber, 90x90 inches. DescriptionL Thicker & Softer: We've upgraded our classic flannel fleece blanket to be softer and warmer than ever, now featuring enhanced premium microfiber. Perfect by itself or as an extra sheet on cold nights, its fluffy and ultra-cozy softness offers the utmost comfort all year round.
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
Fabric Warmth Description	Lightweight))`;

    const selectedMatch = selectedMatchContext?.visual_matches?.[0]; // Use only the single selected match

    if (selectedMatch) {
        // Extract key info for clarity in the prompt
        const matchTitle = selectedMatch.title;
        const matchPrice = selectedMatch.price?.extracted_value ?? 'N/A';
        const matchSource = selectedMatch.source;
        const matchLink = selectedMatch.link;
        const matchThumb = selectedMatch.thumbnail; // Add thumbnail for context

        // Stringify only essential parts for context, not the whole object necessarily
        const relevantMatchContext = `Title: ${matchTitle}\nPrice: ${matchPrice} USD (approx.)\nSource: ${matchSource}\nLink: ${matchLink}`; // Removed JSON stringify for better readability by LLM

        promptText += `\n\nIMPORTANT CONTEXT: The user has indicated the product is similar to the following item found online. Use this information strategically for generating competitive pricing, naming conventions, descriptions, and category suggestions:\n---\n${relevantMatchContext}\nThumbnail: ${matchThumb}\n---`;

        promptText += `\n\nSTRATEGIC GUIDANCE BASED ON CONTEXT:\n1.  **Pricing:** Analyze the provided match price (${matchPrice} USD). Suggest a competitive 'price' in USD for the product in the image. If appropriate, also suggest a slightly higher 'compareAtPrice'.\n2.  **Titling:** Look at the match title ("${matchTitle}"). Generate a unique but similarly styled, keyword-rich 'title' for the product image.\n3.  **Description:** Infer key features from the image and potentially the match title. Write a compelling 'description'. Use keywords inspired by the match context.\n4.  **Categorization:** Based on the match and the image, suggest the most relevant product 'categorySuggestion' (e.g., "Clothing > Men's Shirts > T-Shirts").`;

    } else {
        promptText += `\n\nNo specific visual match context was provided. Base your analysis primarily on the product image. For pricing, use general knowledge of similar items, aiming for a reasonable market value in USD.`;
    }

    promptText += `\n\nPLATFORM-SPECIFIC REQUIREMENTS:\nGenerate details tailored for listing on the following e-commerce platforms: ${targetPlatforms.join(', ')}. For EACH platform specified, provide the relevant fields listed below. If a field is not applicable or cannot be determined, omit it or set it to null.`;

    // Dynamically add platform-specific instructions only for requested platforms
    const platformInstructions = {
        shopify: `- Shopify: Suggest 'status' ('active' or 'draft'), 'vendor' (if inferable, maybe from match source?), 'productType' (Shopify's category e.g., "T-Shirt"), and 'tags' (array of relevant keywords).`,
        square:  `- Square: Suggest 'categorySuggestion', 'gtin' (extract from match barcode if present), 'locations' (suggest "All Available Locations").`,
        ebay:    `- eBay: Suggest 'categorySuggestion', 'condition' ("New", "Used", etc.), 'listingFormat' ("FixedPrice"), 'duration' ("GTC"), 'dispatchTime' ("1 business day"), 'returnPolicy' (basic text like "30-day returns accepted"), 'shippingService' (e.g., "USPS Ground Advantage"), 'itemLocationPostalCode' (if inferable), and 'itemSpecifics' (object with key/value pairs like "Brand", "Size", "Color", "Material" based on image/context).`,
        amazon:  `- Amazon: Suggest 'categorySuggestion', 'condition', 'brand', 'bullet_points' (3-5 concise points), 'search_terms' (array of keywords), 'amazonProductType' (the Amazon product type string, e.g., "CLOTHING"), and 'productIdType' (like 'UPC', 'EAN', 'ASIN' if match suggests it).`,
        facebook:`- Facebook MP: Suggest 'categorySuggestion', 'brand', 'condition', and 'availability' ("in stock").`,
        clover: `- Clover: Suggest 'categorySuggestion', 'brand', 'condition', and 'availability' ("in stock").`
    };

    targetPlatforms.forEach(platform => {
        const key = platform.toLowerCase();
        if (platformInstructions[key]) {
            promptText += `\n${platformInstructions[key]}`;
        }
    });


    promptText += `\n\nCOMMON FIELDS (Include for all platforms where applicable):\n- 'title': Concise and appealing.\n- 'description': Detailed, highlighting features and benefits.\n- 'price': Suggested price in USD (required).\n- 'compareAtPrice': Optional higher price for showing discounts.\n- 'weight': Estimated weight.\n- 'weightUnit': e.g., 'kg' or 'lb'.\n- 'brand': Product brand, if identifiable or from context.\n- 'condition': Product condition.\n\nOUTPUT FORMAT:\nOutput ONLY a single, valid JSON object. The top-level keys MUST be the lowercase platform names provided (${targetPlatforms.map(p => p.toLowerCase()).join(', ')}). Each platform key's value must be an object containing the generated fields relevant to that platform. Do NOT include any text before or after the JSON object. Ensure all strings within the JSON are properly escaped.Strictly adhere to the JSON format. Output ONLY the JSON object, with no introductory text or explanations.

Example for ["shopify", "amazon"]:
{
  "shopify": {
    "title": "Example T-Shirt",
    "description": "...",
    "price": 19.99,
    "compareAtPrice": 24.99,
    "categorySuggestion": "Apparel & Accessories > Clothing > Shirts & Tops",
    "tags": ["cotton", "graphic tee", "casual"],
    "weight": 0.2,
    "weightUnit": "POUNDS", // POUNDS, KILOGRAMS, OUNCES, and GRAMS are the only weight units that are accepted by Shopify
    "brand": "ExampleBrand",
    "condition": "New",
    "status": "active",
    "vendor": "ExampleBrand",
    "productType": "T-Shirt"
  },
  "amazon": {
    "title": "Example Brand Men's Cotton Graphic T-Shirt",
    "description": "...",
    "price": 19.99,
    "compareAtPrice": null, // or omit
    "categorySuggestion": "Clothing, Shoes & Jewelry > Men > Clothing > Shirts > T-Shirts",
    "weight": 0.2,
    "weightUnit": "lb",
    "brand": "ExampleBrand",
    "condition": "New",
    "bullet_points": ["100% Cotton", "...", "..."],
    "search_terms": ["mens tee", "graphic t-shirt", "cotton shirt"],
    "amazonProductType": "SHIRT", // Example
    "productIdType": null // or UPC/EAN if applicable
  }
}
`;
    // --- End Prompt Text Construction ---

    // --- Construct the Multimodal Message Content ---
    const messageContentArray: ChatCompletionContentPart[] = [ // Ensure type compatibility
        { type: "text", text: promptText },
        { type: "image_url", image_url: { url: coverImageUrl } },
    ];

    this.logger.log(`Generating details using Groq (${model}) for platforms: ${targetPlatforms.join(', ')}. Analyzing image: ${coverImageUrl}`);
    this.logger.debug(`Groq Prompt Text:\n${promptText}`); // Log the full prompt for debugging

    try {
      const chatCompletion = await this.groq.chat.completions.create({
        messages: [
            // Pass the correctly typed array
            { role: "user", content: messageContentArray }
        ],
        model: model,
        temperature: 0.5, // Slightly lower temp for more predictable JSON structure
        max_tokens: 4096, // Keep high for potentially long descriptions/multiple platforms
        top_p: 1,
        response_format: { type: "json_object" },
      });

      const responseContent = chatCompletion.choices[0]?.message?.content;

      if (!responseContent) {
          throw new Error('Groq response content is empty.');
      }

      this.logger.debug(`Raw Groq Response:\n${responseContent}`); // Log raw response
      this.logger.log('Successfully received Groq multimodal response.');
      // Parse the JSON content
      const generatedData = JSON.parse(responseContent) as GeneratedDetails;

       // Basic validation: Check if all requested platforms have a key
      let allPlatformsPresent = true;
      for (const platform of targetPlatforms) {
          const platformKey = platform.toLowerCase();
          if (!generatedData[platformKey]) {
              this.logger.warn(`Groq response missing expected top-level key for platform: ${platformKey}`);
              allPlatformsPresent = false;
              // Optionally, create an empty object for the missing platform to avoid downstream errors
              // generatedData[platformKey] = {};
          }
      }
      if (!allPlatformsPresent) {
          // Decide if this is an error or just a warning. Maybe throw if crucial platforms are missing?
          // For now, just log.
      }

      return generatedData;

    } catch (error) {
      this.logger.error(`Groq API multimodal request failed: ${error.message}`, error.stack);
      if (error instanceof SyntaxError) {
          this.logger.error(`Failed to parse Groq response as JSON. Raw Content: ${error['responseContent'] || 'N/A'}`); // Log raw content on parse error
          throw new InternalServerErrorException('AI failed to generate valid JSON details. Check logs for raw response.');
      }
      // Add specific checks for Groq errors if needed
      throw new InternalServerErrorException(`AI content generation failed: ${error.message}`);
    }
  }
}

