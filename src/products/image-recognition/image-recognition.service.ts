import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getJson } from 'serpapi'; // Import the serpapi client

// Define a type for the expected visual matches structure (based on your example)
export interface VisualMatch {
  position: number;
  title: string;
  link?: string;
  source?: string;
  thumbnail?: string;
  image?: string;
  price?: { // Add price from example
      value?: string;
      extracted_value?: number;
      currency?: string;
  };
  in_stock?: boolean;
  rating?: number;
  reviews?: number;
  condition?: string;
  // Add other fields you might need
}

export interface SerpApiLensResponse {
    search_metadata: {
        id: string;
        status: string;
        google_lens_url: string;
        // ... other metadata
    };
    visual_matches?: VisualMatch[];
    // Add other potential fields like 'products', 'related_content' if needed
}

@Injectable()
export class ImageRecognitionService {
  private readonly logger = new Logger(ImageRecognitionService.name);
  private readonly serpApiKey?: string; // Make key potentially undefined

  constructor(private readonly configService: ConfigService) {
    const key = this.configService.get<string>('SERPAPI_API_KEY');
    if (!key) {
      this.logger.error('SERPAPI_API_KEY is not configured. Image recognition disabled.');
    }
    this.serpApiKey = key; // Assign potentially undefined key
  }

  async analyzeImageByUrl(imageUrl: string): Promise<SerpApiLensResponse | null> {
    // Check if the key exists before making the call
    if (!this.serpApiKey) {
        this.logger.warn('Cannot analyze image: SerpApi key is missing.');
        return null; // Or throw if this is critical
    }

    this.logger.log(`Starting image analysis for URL: ${imageUrl}`);

    try {
      // Use the 'google_lens' engine
      const response = await getJson({
        engine: 'google_lens',
        url: imageUrl,
        api_key: this.serpApiKey, // Use the checked key
        // no_cache: 'true' // Add if you want fresh results every time during testing
      });

      this.logger.log(`Successfully received SerpApi response for ${imageUrl}`);
      // You might want to validate the response structure here
      return response as SerpApiLensResponse;

    } catch (error) {
      this.logger.error(`SerpApi Google Lens request failed for ${imageUrl}: ${error.message}`, error.stack);
      // Don't necessarily throw InternalServerError, maybe just return null or a specific error status
      // throw new InternalServerErrorException(`Image analysis failed: ${error.message}`);
       return null; // Indicate failure
    }
  }
}
