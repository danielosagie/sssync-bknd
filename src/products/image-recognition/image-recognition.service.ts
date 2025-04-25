import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as SerpApiClient from 'google-search-results-nodejs'; // Ensure this is installed and imported

// Interface for a single visual match from SerpApi Lens
export interface VisualMatch {
    position?: number;
    title?: string;
    link?: string;
    source?: string;
    price?: {
        value?: string;
        currency?: string;
        extracted_value?: number;
    };
    thumbnail?: string;
    source_icon?: string;
    snippet?: string;
}

// Interface for the overall SerpApi Lens response structure
export interface SerpApiLensResponse {
    search_metadata?: {
        id?: string;
        status?: string;
        json_endpoint?: string;
        created_at?: string;
        processed_at?: string;
        google_lens_url?: string;
        raw_html_file?: string;
        total_time_taken?: number;
    };
    search_parameters?: {
        q?: string;
        engine?: string;
        google_domain?: string;
        hl?: string;
        gl?: string;
    };
    visual_matches?: VisualMatch[];
    related_searches?: Array<{
        query?: string;
        link?: string;
    }>;
    text_results?: Array<{
         text?: string;
         link?: string;
    }>;
    error?: any;
}

@Injectable()
export class ImageRecognitionService {
    private readonly logger = new Logger(ImageRecognitionService.name);
    private readonly serpApi: SerpApiClient.GoogleSearch | null = null; // Allow null if key missing

    constructor(private configService: ConfigService) {
        const apiKey = this.configService.get<string>('SERPAPI_KEY');
        if (apiKey) {
            this.serpApi = new SerpApiClient.GoogleSearch(apiKey);
        } else {
            this.logger.warn('SERPAPI_KEY not set. Image recognition (SerpApi Lens) disabled.');
        }
    }

    /**
     * Analyzes an image using Google Lens via SerpApi.
     * @param imageUrl The public URL of the image to analyze.
     * @returns The SerpApiLensResponse object or null if the service is disabled or fails.
     */
    async analyzeImageWithLens(imageUrl: string): Promise<SerpApiLensResponse | null> {
        if (!this.serpApi) {
            this.logger.warn('SerpApi service not available. Skipping analysis.');
            return null;
        }

        this.logger.log(`Analyzing image URL with SerpApi Lens: ${imageUrl}`);

        try {
            const result = await new Promise<SerpApiLensResponse>((resolve, reject) => {
                this.serpApi!.json({
                    engine: "google_lens",
                    url: imageUrl,
                    hl: "en",
                    gl: "us",
                }, (data) => {
                    resolve(data);
                });
            });

            if (result.error) {
                this.logger.error(`SerpApi Lens analysis failed: ${result.error}`);
            } else {
                 this.logger.log(`SerpApi Lens analysis successful for ${imageUrl}. Found ${result.visual_matches?.length || 0} visual matches.`);
            }
            return result;

        } catch (error) {
            this.logger.error(`Error calling SerpApi Lens for ${imageUrl}: ${error.message}`, error.stack);
            return { error: error.message || 'Unknown error during SerpApi call' };
        }
    }
}
