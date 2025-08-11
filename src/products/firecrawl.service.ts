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
  private apiKey: string | null = null;
  private baseUrl = 'https://api.firecrawl.dev/v1';

  constructor(
    private readonly configService: ConfigService,
    private readonly supabaseService: SupabaseService,
  ) {
    const apiKey = this.configService.get<string>('FIRECRAWL_API_KEY');
    if (!apiKey) {
      this.logger.warn('FIRECRAWL_API_KEY is not configured. FirecrawlService will be disabled.');
      this.apiKey = null;
      return;
    }
    this.apiKey = apiKey;
  }

  /**
   * Search the web and optionally extract content from search results
   */
  async search(query: string): Promise<any> {
    if (!this.apiKey) throw new Error('FirecrawlService not initialized (missing FIRECRAWL_API_KEY).');
    this.logger.log(`Searching with Firecrawl: ${query}`);
    const res = await fetch(`${this.baseUrl}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) {
      const text = await res.text();
      this.logger.error(`Firecrawl search error ${res.status}: ${text}`);
      throw new Error(`Firecrawl search failed: ${res.status}`);
    }
    return res.json();
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
    if (!this.apiKey) throw new Error('FirecrawlService not initialized (missing FIRECRAWL_API_KEY).');
    this.logger.log(`Extracting data from ${urls.length} URLs`);
    const res = await fetch(`${this.baseUrl}/extract`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ urls, schema, ...options }),
    });
    if (!res.ok) {
      const text = await res.text();
      this.logger.error(`Firecrawl extract error ${res.status}: ${text}`);
      throw new Error(`Firecrawl extract failed: ${res.status}`);
    }
    const json = await res.json();
    // Expect json.data or array; normalize
    const data = (json?.data && Array.isArray(json.data)) ? json.data : (Array.isArray(json) ? json : []);
    return data as FirecrawlExtractResult[];
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
    if (!this.apiKey) throw new Error('FirecrawlService not initialized (missing FIRECRAWL_API_KEY).');
    this.logger.log(`Scraping with Firecrawl: ${url}`);
    const res = await fetch(`${this.baseUrl}/scrape`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) {
      const text = await res.text();
      this.logger.error(`Firecrawl scrape error ${res.status}: ${text}`);
      throw new Error(`Firecrawl scrape failed: ${res.status}`);
    }
    return res.json();
  }

  async deepProductSearch(
    query: string,
    options: {
      websites?: string[];
      businessTemplate?: string;
    } = {}
  ): Promise<any[]> {
    try {
      const searchResults = await this.search(query);
      const targetWebsites = options.websites;

      if (!targetWebsites || targetWebsites.length === 0) {
        this.logger.warn('No websites provided for deep product search, returning raw search results.');
        return searchResults.data || [];
      }
      
      const urlsToScrape = searchResults.data
        .filter(r => targetWebsites.some(w => r.url.includes(w)))
        .map(r => r.url)
        .slice(0, 5); // Limit to top 5 relevant URLs

      if (urlsToScrape.length === 0) {
        this.logger.log('No relevant URLs found in initial search for deep product search.');
        return [];
      }

      const schema = this.getProductSchema(options.businessTemplate);
      // Add imageUrl to the schema we want to extract
      schema.properties.imageUrl = { type: 'string', description: 'The URL of the main product image.' };

      const extractedData = await this.extract(urlsToScrape, schema);
      return extractedData;

    } catch (error) {
      this.logger.error(`Deep product search failed for query "${query}":`, error);
      throw new Error(`Failed to perform deep product search: ${error.message}`);
    }
  }
} 