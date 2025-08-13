import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../common/supabase.service';
import FirecrawlApp, { SearchResponse } from '@mendable/firecrawl-js';

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
  private fcApiKey: string | undefined;
  private baseUrl = 'https://api.firecrawl.dev/v1';
 

  constructor(
    private readonly configService: ConfigService,
    private readonly supabaseService: SupabaseService,
  ) {
    // Read from ConfigService first, fallback to process.env
    this.fcApiKey = this.configService.get<string>('FIRECRAWL_API_KEY') || process.env.FIRECRAWL_API_KEY;
    if (!this.fcApiKey) {
      this.logger.warn('FIRECRAWL_API_KEY is not configured. FirecrawlService will be disabled.');
    } else {
      try {
        // Initialize SDK instance (optional for future use)
        const _app = new FirecrawlApp({ apiKey: this.fcApiKey });
        this.logger.log('FirecrawlService initialized');
      } catch (e) {
        this.logger.warn(`Firecrawl SDK init warning: ${e?.message || e}`);
      }
    }
  }


  /**
   * Search the web and optionally extract content from search results
   */

  async search(query: string, opts: { limit?: number; scrapeOptions?: { formats?: string[] } } = {}): Promise<any> {
    if (!this.fcApiKey) throw new Error('FirecrawlService not initialized (missing FIRECRAWL_API_KEY).');
    this.logger.log(`Searching with Firecrawl: ${query}`);
    const res = await fetch(`${this.baseUrl}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.fcApiKey}`,
      },
      body: JSON.stringify({ query, limit: opts.limit ?? 5, scrapeOptions: opts.scrapeOptions }),
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
    if (!this.fcApiKey) throw new Error('FirecrawlService not initialized (missing FIRECRAWL_API_KEY).');
    this.logger.log(`Extracting data from ${urls.length} URLs`);
    const res = await fetch(`${this.baseUrl}/extract`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.fcApiKey}`,
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
    let data = (json?.data && Array.isArray(json.data)) ? json.data : (Array.isArray(json) ? json : []);

    // Fallback: if extract returns empty, do lightweight scrape for content
    if (!data || data.length === 0) {
      this.logger.warn(`Firecrawl extract returned 0 results. Falling back to scrape() for ${urls.length} URL(s).`);
      const scraped = await this.scrapeMany(urls);
      // Map to a consistent structure for downstream usage
      data = scraped.map(s => ({ url: s.url, title: s.metadata?.title, markdown: s.markdown, html: s.html, links: s.links }));
    }

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
    if (!this.fcApiKey) throw new Error('FirecrawlService not initialized (missing FIRECRAWL_API_KEY).');
    this.logger.log(`Scraping with Firecrawl: ${url}`);
    const res = await fetch(`${this.baseUrl}/scrape`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.fcApiKey}`,
      },
      body: JSON.stringify({ url, formats: ['markdown', 'links', 'html'] }),
    });
    if (!res.ok) {
      const text = await res.text();
      this.logger.error(`Firecrawl scrape error ${res.status}: ${text}`);
      throw new Error(`Firecrawl scrape failed: ${res.status}`);
    }
    return res.json();
  }

  async scrapeMany(urls: string[]): Promise<Array<{ url: string; markdown?: string; html?: string; links?: string[]; metadata?: any }>> {
    const results: Array<{ url: string; markdown?: string; html?: string; links?: string[]; metadata?: any }> = [];
    for (const url of urls) {
      try {
        const out = await this.scrape(url);
        const data = out?.data || out || {};
        results.push({ url, markdown: data.markdown, html: data.html, links: data.links, metadata: data.metadata });
      } catch (err) {
        this.logger.warn(`Scrape failed for ${url}: ${err?.message || err}`);
      }
    }
    return results;
  }

  async deepProductSearch(
    query: string,
    options: {
      websites?: string[];
      businessTemplate?: string;
    } = {}
  ): Promise<any[]> {
    try {
      const searchResults = await this.search(query, { limit: 6, scrapeOptions: { formats: ['links'] } });
      const targetWebsites = options.websites;

      if (!targetWebsites || targetWebsites.length === 0) {
        this.logger.warn('No websites provided for deep product search, returning raw search results.');
        return searchResults.data || [];
      }
      
      const urlsToScrape = (searchResults.data || [])
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