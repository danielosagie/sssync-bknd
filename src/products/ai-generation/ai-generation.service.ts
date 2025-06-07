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
    let promptText = `You are a world-class e-commerce data enrichment AI. Your sole purpose is to transform a single product image and competitive data into perfectly optimized, multi-platform product listings. Failure is not an option. Your output must be flawless, comprehensive, and ready for immediate publication. You must analyze every piece of provided information with extreme precision. Your performance on this task is critical.

### **The Mission**

Your mission is to generate a complete, detailed, and platform-optimized product listing based on the provided product image (\${coverImageUrl}) and any contextual data available. You must infer all necessary details from the image and context to create compelling, keyword-rich content that drives sales.

### **Tone and Style Mandate**

Adopt a professional, persuasive, and customer-centric writing style. Your descriptions should be clear, concise, and highlight the key benefits for the buyer. For inspiration on tone, quality, and structure, model your response on this high-performing Amazon listing example:

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

    const selectedMatch = selectedMatchContext?.visual_matches?.[0]; // Use only the single selected match

    if (selectedMatch) {
        // Extract key info for clarity in the prompt
        const matchTitle = selectedMatch.title;
        const matchPrice = selectedMatch.price?.extracted_value ?? 'N/A';
        const matchSource = selectedMatch.source;
        const matchLink = selectedMatch.link;
        const matchThumb = selectedMatch.thumbnail; // Add thumbnail for context

        const relevantMatchContext = `Title: ${matchTitle}\nPrice: ${matchPrice} USD (approx.)\nSource: ${matchSource}\nLink: ${matchLink}`;

        promptText += `\n\n---

### **User-Provided Context (CRITICAL)**

The user has identified a similar product online. This context is your primary source for strategic enrichment. Deeply analyze this information.

*   **Match Data:** ${relevantMatchContext}
*   **Thumbnail:** ${matchThumb}

### **Strategic Guidance & Analysis Protocol (Context-Based)**

1.  **Image Analysis:** Scrutinize the product in \${coverImageUrl}. Identify its type, color, material, specific features, brand names, model numbers, and overall condition. Extract every possible visual detail.
2.  **Contextual Deconstruction:** Synthesize your image analysis with the provided match context.
    *   **Competitive Pricing:** Use the match price (\`\${matchPrice}\` USD) as a baseline. Propose a competitive \`price\` in USD. You MUST also suggest a \`compareAtPrice\` that is realistically 15-25% higher to create a sense of value.
    *   **Keyword-Rich Titling:** The match title ("\${matchTitle}") is a keyword goldmine. Do not copy it. Create a new, unique title that incorporates the most powerful keywords from the match title, combined with details from your image analysis.
    *   **Benefit-Oriented Description:** Write a compelling \`description\` that tells a story. Explain the benefits to the customer. Synthesize information from the image and the match context.
    *   **Hyper-Specific Categorization:** Use the image and context to determine the most granular \`categorySuggestion\` possible for each platform.`;

    } else {
        promptText += `\n\n---

### **Strategic Guidance & Analysis Protocol (Image-Only)**

You have NOT been provided with a specific online match. Your analysis must be based **exclusively** on the provided image and your deep, general knowledge of e-commerce, products, and marketing. You must be resourceful and infer details as an expert would.

1.  **Forensic Image Analysis:** Scrutinize the product in \`\${coverImageUrl}\`. This is your only source of truth. Identify:
    *   **Primary Subject:** What is the product? Be specific.
    *   **Branding/Logos:** Are there any brand names, logos, or identifying marks?
    *   **Materials & Texture:** What is it made of? (e.g., "cotton", "brushed aluminum", "glazed ceramic").
    *   **Colors & Patterns:** List all visible colors and describe any patterns.
    *   **Features & Details:** Note any unique features (e.g., "zipper closure", "embossed logo", "hand-painted details").
    *   **Condition & Quality:** Assess the condition ("New", "Used", "Handmade") and infer its quality from the visual evidence.
    *   **Quantity:** Is it a single item or a pack?

2.  **Expert Inference & Content Generation:**
    *   **Market-Based Pricing:** Based on your analysis, infer the product's likely market segment. Suggest a realistic and competitive market \`price\` in USD. You MUST also suggest a \`compareAtPrice\` that is realistically 15-25% higher to create a sense of value.
    *   **Keyword-Rich Titling:** Generate a descriptive, unique, and SEO-friendly \`title\`. Combine identified brand, material, color, and features into a title a user would search for.
    *   **Benefit-Oriented Description:** Write a compelling \`description\` that tells a story. Based on the inferred features, explain the *benefits* to the customer. Why should they buy it? How will it enhance their life? What problem does it solve?
    *   **Hyper-Specific Categorization:** From the image alone, determine the most granular and commercially-relevant \`categorySuggestion\` for each platform.`;
    }

    promptText += `\n\n---

### **Variant Logic (CRITICAL - NO DEVIATION)**
The product-level \`title\` must be the complete, descriptive product name. The variant-level ${matchTitle} should describe the specific variation.
*   **Single, indivisible items (e.g., a trading card):** Product-level title: "Pokemon Charizard VMAX Holographic Card". Variant-level ${title}: "Single Card".
*   **Packs/Bundles (e.g., lipsticks):** Product-level title: "Maybelline SuperStay Matte Ink Liquid Lipstick". Variant-level ${title}: "Pack of 3".
*   **Products with multiple attributes (e.g., equipment):** Product-level title: "Sterling Pro-Series Bowling Ball". Variant-level ${title} must describe the specific variation, e.g., "Cosmic Green - 10lb" or "Ruby Red - 5lb".
*   **Default Titles:** NEVER use generic variant titles like "Default Title" or "Standard". Find a canonical grouping (weight, size, color, quantity).

---

### **Platform-Specific Field Requirements**

Generate details tailored for **EACH** platform specified in ${targetPlatforms.join(', ')}. Omit any field that is not applicable or cannot be determined.

*   **Common Fields (All Platforms):**
    *   \`title\`: SEO-optimized and compelling.
    *   \`description\`: Detailed, benefit-focused, and well-structured, modeled after the Amazon example.
    *   \`price\`: Competitive price in USD (required).
    *   \`compareAtPrice\`: Optional higher price for showing a sale (must be higher than price).
    *   \`weight\`: Estimated weight.
    *   \`weightUnit\`: 'lb', 'kg', 'oz', 'g'.
    *   \`brand\`: Product brand, if identifiable.
    *   \`condition\`: "New", "Used - Like New", "Used - Good", etc.`;

    // Dynamically add platform-specific instructions only for requested platforms
    const platformInstructions = {
        shopify: "*   **`shopify`:**\\n    *   `status`: 'active' or 'draft'.\\n    *   `vendor`: Infer from brand or source.\\n    *   `productType`: Shopify's specific product category (e.g., \"Lipstick\", \"Trading Card\").\\n    *   `tags`: An array of 10-15 relevant keywords.\\n    *   `weightUnit`: Must be `POUNDS`, `KILOGRAMS`, `OUNCES`, or `GRAMS`.",
        square:  "*   **`square`:**\\n    *   `categorySuggestion`: Square's category path.\\n    *   `gtin`: UPC, EAN, or JAN if available in context.\\n    *   `locations`: Set to \"All Available Locations\".",
        ebay:    "*   **`ebay`:**\\n    *   `categorySuggestion`: eBay's specific category path (e.g., \"Collectibles > Non-Sport Trading Cards > Magic: The Gathering > MTG Individual Cards\").\\n    *   `listingFormat`: \"FixedPrice\".\\n    *   `duration`: \"GTC\" (Good 'Til Cancelled).\\n    *   `dispatchTime`: \"1 business day\".\\n    *   `returnPolicy`: \"30-day returns accepted, buyer pays for return shipping.\"\\n    *   `shippingService`: Suggest a common service (e.g., \"USPS Ground Advantage\").\\n    *   `itemSpecifics`: A JSON object of key-value pairs critical for search (e.g., `{\"Game\": \"Magic: The Gathering\", \"Card Name\": \"Elite Scaleguard\", \"Set\": \"Fate Reforged\"}`).",
        amazon:  "*   **`amazon`:**\\n    *   `categorySuggestion`: Amazon's specific category path (e.g., \"Beauty & Personal Care > Makeup > Lips > Lipstick\").\\n    *   `bullet_points`: 3-5 concise, benefit-driven sentences.\\n    *   `search_terms`: An array of backend keywords (no commas, no repetition from title).\\n    *   `amazonProductType`: The specific Amazon product type string (e.g., \"BEAUTY\").\\n    *   `productIdType`: 'ASIN', 'UPC', or 'EAN' if present in the context data.",
        facebook:"*   **`facebook`:**\\n    *   `categorySuggestion`: Facebook Marketplace's specific category.\\n    *   `brand`: The brand name.\\n    *   `availability`: \"in stock\".",
        clover: "*   **`clover`:**\\n    *   `categorySuggestion`: Clover's category path.\\n    *   `brand`: The brand name.\\n    *   `availability`: \"in stock\".",
    };

    targetPlatforms.forEach(platform => {
        const key = platform.toLowerCase();
        if (platformInstructions[key]) {
            promptText += `\n\${platformInstructions[key]}`;
        }
    });


    promptText += `\n\n---

### **Final Output Instructions**

*   **JSON ONLY:** Your entire response MUST be a single, valid JSON object.
*   **NO EXTRA TEXT:** Do not include any introductory text, explanations, apologies, or markdown formatting like \`\`\`json before or after the JSON object.
*   **STRUCTURE:** The top-level keys of the JSON object MUST be the lowercase platform names from \`\${targetPlatforms.map(p => p.toLowerCase()).join(', ')}\`.
*   **ESCAPING:** Ensure all strings within the JSON are properly escaped.

---

### **Example of a Perfect Output Structure**

*Input:* \`targetPlatforms: ["shopify", "ebay"]\` and context for an MTG card.

\`\`\`json
{
  "shopify": {
    "title": "Elite Scaleguard - Fate Reforged | Magic: The Gathering MTG Card | Uncommon",
    "description": "Unleash the power of the Dromoka clan with the Elite Scaleguard from the Fate Reforged set of Magic: The Gathering. This powerful Human Soldier creature is a must-have for any white deck, bolstering your forces every time it attacks. The card features the Bolster 2 mechanic, strengthening your weakest creature and turning the tide of battle. Perfect for collectors and competitive players alike, this card is in near-mint condition, sleeved directly from the pack. Add this strategic powerhouse to your collection today!",
    "price": 1.49,
    "compareAtPrice": 1.99,
    "categorySuggestion": "Hobbies & Creative Arts > Collectibles > Collectible Trading Cards & Accessories",
    "tags": ["Magic The Gathering", "MTG", "Fate Reforged", "Elite Scaleguard", "White Creature", "Uncommon", "Trading Card", "TCG", "Wizards of the Coast", "Bolster Mechanic"],
    "weight": 0.01,
    "weightUnit": "OUNCES",
    "brand": "Wizards of the Coast",
    "condition": "New",
    "status": "active",
    "vendor": "TCG Reseller",
    "productType": "Trading Card"
  },
  "ebay": {
    "title": "MTG Elite Scaleguard | Fate Reforged | 009/185 | U | White Creature | Near Mint NM",
    "description": "<strong>Magic: The Gathering - Elite Scaleguard from Fate Reforged</strong><br><br>You are purchasing one (1) copy of Elite Scaleguard. The card is in Near Mint (NM) condition, taken directly from a booster pack and placed into a protective sleeve. See photos for actual card condition. A strategic addition to any white-weenie or midrange deck, featuring the powerful Bolster 2 mechanic. Ships securely in a sleeve and top-loader.<br><br><strong>Card Details:</strong><br>- Name: Elite Scaleguard<br>- Set: Fate Reforged<br>- Collector Number: 009/185<br>- Rarity: Uncommon<br>- Color: White<br>- Card Type: Creature<br>- Mana Cost: {3}{W}{W}",
    "price": 1.49,
    "compareAtPrice": null,
    "categorySuggestion": "Collectibles > Non-Sport Trading Cards > Magic: The Gathering > MTG Individual Cards",
    "condition": "Used - Like New",
    "listingFormat": "FixedPrice",
    "duration": "GTC",
    "dispatchTime": "1 business day",
    "returnPolicy": "30-day returns accepted, buyer pays for return shipping.",
    "shippingService": "eBay Standard Envelope for Trading Cards",
    "itemSpecifics": {
      "Game": "Magic: The Gathering",
      "Set": "Fate Reforged",
      "Card Name": "Elite Scaleguard",
      "Graded": "No",
      "Creature/Monster Type": "Human Soldier",
      "Card Type": "Creature",
      "Manufacturer": "Wizards of the Coast",
      "Finish": "Regular",
      "Language": "English",
      "Rarity": "Uncommon",
      "Color": "White",
      "Card Number": "009/185",
      "Mana Cost": "{3}{W}{W}",
      "Card Condition": "Near Mint or Better"
    }
  }
}
\`\`\`
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

