import { Injectable, InternalServerErrorException, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Groq from 'groq-sdk'; // Import Groq SDK
// Try importing the specific content part type
import { ChatCompletionContentPart } from 'groq-sdk/resources/chat/completions';
import { SerpApiLensResponse, VisualMatch } from '../image-recognition/image-recognition.service'; // Keep using these interfaces

// Define expected output structure based on platform keys
export interface GeneratedDetails {
  [platform: string]: {
    title?: string;
    description?: string;
    price?: number; // Suggest a price?
    category?: string;
    tags?: string[];
    weight?: number;
    weightUnit?: string;
    // Add other common or platform-specific fields
    [key: string]: any; // Allow platform-specific fields
  };
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
    imageUrls: string[], // Keep all URLs for potential future use or different prompts
    coverImageUrl: string, // The primary image for the model to analyze
    targetPlatforms: string[],
    // Accept the whole SerpApi response, or just the visual_matches part
    lensResponse?: SerpApiLensResponse | null,
  ): Promise<GeneratedDetails | null> {

    if (!this.groq) {
        this.logger.warn('Cannot generate details: Groq API key is missing.');
        return null;
    }

    // --- Use the Maverick model ---
    const model = 'meta-llama/llama-4-maverick-17b-128e-instruct';

    // --- Construct the Prompt Text for Groq ---
    // This text accompanies the image input.
    let promptText = `You are an expert e-commerce listing assistant. Analyze the product in the provided image.`;

    if (lensResponse?.visual_matches && lensResponse.visual_matches.length > 0) {
        const relevantMatches = JSON.stringify(lensResponse.visual_matches.slice(0, 5), null, 2); // Limit context slightly more
        promptText += `\n\nConsider these potential visual matches found online for context, pricing, and categorization:\n\`\`\`json\n${relevantMatches}\n\`\`\``;
    } else {
        promptText += `\nNo specific visual matches were provided. Base your analysis primarily on the image.`;
    }

    promptText += `\n\nGenerate product details suitable for listing on the following e-commerce platforms: ${targetPlatforms.join(', ')}. Provide details including:
- A concise and appealing title.
- A detailed description highlighting key features and benefits.
- A suggested product category.
- Relevant tags or keywords.
- An estimated price based on the provided visual matches or general knowledge (state currency as USD).
- An estimated weight in kilograms (if applicable).
- Any other relevant specifications commonly required for these platforms (e.g., Shopify 'tags', Amazon 'bullet_points').

Format the output ONLY as a valid JSON object where keys are the platform names (lowercase, e.g., "shopify", "amazon") and values are objects containing the generated fields ("title", "description", "price", "category", "tags", "weight", "weightUnit", etc.).

Strictly adhere to the JSON format. Output ONLY the JSON object, with no introductory text or explanations.`;
    // --- End Prompt Text Construction ---

    // --- Construct the Multimodal Message Content ---
    // Define the array with the correct structure
    const messageContentArray = [
        { type: "text" as const, text: promptText }, // Use 'as const' for literal types
        { type: "image_url" as const, image_url: { url: coverImageUrl } },
    ];

    this.logger.log(`Generating details using Groq (${model}) for platforms: ${targetPlatforms.join(', ')}. Analyzing image: ${coverImageUrl}`);

    try {
      const chatCompletion = await this.groq.chat.completions.create({
        messages: [
            // Explicitly cast the content array to the expected type
            { role: "user", content: messageContentArray as ChatCompletionContentPart[] }
        ],
        model: model,
        temperature: 0.7,
        max_tokens: 4096,
        top_p: 1,
        response_format: { type: "json_object" },
      });

      const responseContent = chatCompletion.choices[0]?.message?.content;

      if (!responseContent) {
          throw new Error('Groq response content is empty.');
      }

      this.logger.log('Successfully received Groq multimodal response.');
      // Parse the JSON content
      const generatedData = JSON.parse(responseContent) as GeneratedDetails;

       // Basic validation
      for (const platform of targetPlatforms) {
          if (!generatedData[platform.toLowerCase()]) {
              this.logger.warn(`Groq response missing expected key for platform: ${platform.toLowerCase()}`);
          }
      }
      return generatedData;

    } catch (error) {
      this.logger.error(`Groq API multimodal request failed: ${error.message}`, error.stack);
      if (error instanceof SyntaxError) {
          this.logger.error('Failed to parse Groq response as JSON.');
          throw new InternalServerErrorException('AI failed to generate valid JSON details.');
      }
      // Add specific checks for Groq errors if needed (e.g., 400 for image size)
      throw new InternalServerErrorException(`AI content generation failed: ${error.message}`);
    }
  }
}
