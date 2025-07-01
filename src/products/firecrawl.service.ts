import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../common/supabase.service';

export interface FirecrawlSearchResult {
  url: string;
  title: string;
  description: string;
  content: string;
  image?: string;
}

export interface FirecrawlExtractResult {
  [key: string]: any;
}

export interface FirecrawlDeepResearchResult {
  finalAnalysis: string;
  sources: string[];
  activities: any[];
}

@Injectable()
export class FirecrawlService {
  private readonly logger = new Logger(FirecrawlService.name);
  private firecrawlApp;

  constructor(
    private readonly configService: ConfigService,
    private readonly supabaseService: SupabaseService,
  ) {
    const apiKey = this.configService.get<string>('FIRECRAWL_API_KEY');
    if (!apiKey) {
      this.logger.warn('FIRECRAWL_API_KEY is not configured. FirecrawlService will be disabled.');
      return;
    }
    // Initialize with dynamic import or mock for now
    this.firecrawlApp = { 
      search: async (query: string, options?: any) => ({ data: [] }),
      scrape: async (params: { url: string }) => ({ data: { markdown: 'Mock content' } })
    };
  }

  /**
   * Search the web and optionally extract content from search results
   */
  async search(query: string): Promise<any> {
    if (!this.firecrawlApp) {
      throw new Error('FirecrawlService is not initialized.');
    }
    this.logger.log(`Searching with Firecrawl: ${query}`);
    try {
      const results = await this.firecrawlApp.search(query, {
        pageOptions: {
          fetchPageContent: false
        }
      });
      return results;
    } catch (error) {
      this.logger.error(`Firecrawl search failed for query: ${query}`, error.stack);
      throw error;
    }
  }

  /**
   * Extract structured data from URLs using schema
   */
  async extract(
    urls: string[],
    schema: any,
    options: {
      prompt?: string;
      systemPrompt?: string;
    } = {}
  ): Promise<FirecrawlExtractResult[]> {
    try {
      this.logger.log(`Extracting data from ${urls.length} URLs`);
      
      // Mock extraction for now
      return urls.map(url => ({
        url,
        title: 'Mock Product',
        price: 99.99,
        description: 'Mock product description',
      }));
    } catch (error) {
      this.logger.error(`Extraction failed for URLs ${urls.join(', ')}:`, error);
      throw new Error(`Failed to extract: ${error.message}`);
    }
  }

  /**
   * Perform deep research on a topic
   */
  async deepResearch(
    query: string,
    options: {
      maxDepth?: number;
      maxUrls?: number;
      timeLimit?: number;
    } = {}
  ): Promise<FirecrawlDeepResearchResult> {
    try {
      this.logger.log(`Starting deep research for: ${query}`);
      
      // Mock deep research for now
      return {
        finalAnalysis: `Mock analysis for "${query}"`,
        sources: [],
        activities: [],
      };
    } catch (error) {
      this.logger.error(`Deep research failed for query "${query}":`, error);
      throw new Error(`Failed to perform deep research: ${error.message}`);
    }
  }

  /**
   * Map a website to discover URLs
   */
  async mapWebsite(
    url: string,
    options: {
      includeSubdomains?: boolean;
      limit?: number;
      search?: string;
    } = {}
  ): Promise<string[]> {
    try {
      this.logger.log(`Mapping website: ${url}`);
      
      // Mock mapping for now
      return [];
    } catch (error) {
      this.logger.error(`Website mapping failed for URL "${url}":`, error);
      throw new Error(`Failed to map website: ${error.message}`);
    }
  }

  /**
   * Get product extraction schema based on business template
   */
  getProductSchema(template?: string): any {
    switch (template) {
      case 'comic-book':
        return {
          type: 'object',
          properties: {
            title: { type: 'string' },
            price: { type: 'number' },
            condition: { type: 'string' },
            grade: { type: 'string' },
            publisher: { type: 'string' },
            issue_number: { type: 'string' },
            publication_date: { type: 'string' },
            description: { type: 'string' },
            key_features: { type: 'array', items: { type: 'string' } },
            characters: { type: 'array', items: { type: 'string' } },
            creators: { type: 'array', items: { type: 'string' } },
            sku: { type: 'string' },
            availability: { type: 'string' },
          },
          required: ['title', 'price'],
        };

      case 'electronics':
        return {
          type: 'object',
          properties: {
            title: { type: 'string' },
            price: { type: 'number' },
            brand: { type: 'string' },
            model: { type: 'string' },
            sku: { type: 'string' },
            description: { type: 'string' },
            specifications: { type: 'object' },
            warranty: { type: 'string' },
            compatibility: { type: 'array', items: { type: 'string' } },
            condition: { type: 'string' },
            availability: { type: 'string' },
          },
          required: ['title', 'price', 'brand'],
        };

      case 'fashion':
        return {
          type: 'object',
          properties: {
            title: { type: 'string' },
            price: { type: 'number' },
            brand: { type: 'string' },
            size: { type: 'string' },
            color: { type: 'string' },
            material: { type: 'string' },
            care_instructions: { type: 'string' },
            sku: { type: 'string' },
            description: { type: 'string' },
            gender: { type: 'string' },
            category: { type: 'string' },
            condition: { type: 'string' },
            availability: { type: 'string' },
          },
          required: ['title', 'price', 'brand'],
        };

      default:
        // General product schema
        return {
          type: 'object',
          properties: {
            title: { type: 'string' },
            price: { type: 'number' },
            description: { type: 'string' },
            brand: { type: 'string' },
            sku: { type: 'string' },
            condition: { type: 'string' },
            availability: { type: 'string' },
            category: { type: 'string' },
            specifications: { type: 'object' },
          },
          required: ['title', 'price'],
        };
    }
  }

  /**
   * Generate search prompt for product research
   */
  generateSearchPrompt(productContext: {
    imageAnalysis?: string;
    businessType?: string;
    visualMatches?: any[];
  }): string {
    const { imageAnalysis, businessType, visualMatches } = productContext;
    
    let prompt = 'Find detailed product information including:';
    
    if (businessType === 'comic-book') {
      prompt += ' title, issue number, publisher, creators, grade/condition, price, and key story elements or character appearances.';
    } else if (businessType === 'electronics') {
      prompt += ' specifications, model numbers, compatibility, warranty information, and pricing.';
    } else if (businessType === 'fashion') {
      prompt += ' brand, size information, materials, care instructions, and styling details.';
    } else {
      prompt += ' brand, model, specifications, pricing, and availability.';
    }

    if (imageAnalysis) {
      prompt += ` Based on image analysis: ${imageAnalysis}`;
    }

    if (visualMatches?.length) {
      prompt += ` Consider these visual matches: ${visualMatches.map(m => m.title).join(', ')}`;
    }

    return prompt;
  }

  async scrape(url: string): Promise<any> {
    if (!this.firecrawlApp) {
      throw new Error('FirecrawlService is not initialized.');
    }
    this.logger.log(`Scraping with Firecrawl: ${url}`);
    try {
      const result = await this.firecrawlApp.scrape({ url });
      return result;
    } catch (error) {
      this.logger.error(`Firecrawl scrape failed for url: ${url}`, error.stack);
      throw error;
    }
  }

  async deepProductSearch(
    query: string,
    options: {
      websites?: string[];
      businessTemplate?: string;
    } = {}
  ): Promise<any[]> {
    const searchQuery = options.websites 
      ? `${query} site:${options.websites.join(' OR site:')}`
      : query;
    
    const results = await this.search(searchQuery);
    return results.data || [];
  }
} 