export interface GenerateJobData {
  type: 'generate-job';
  jobId: string;
  userId: string;
  products: Array<{
    productIndex: number;
    productId?: string;
    variantId?: string;
    imageUrls: string[];
    coverImageIndex: number;
    selectedMatches?: Array<any>; // SerpAPI selections or structured picks
  }>;
  selectedPlatforms: string[]; // e.g., ['shopify', 'amazon']
  template?: string | null;
  // Optional: fine-grained per-platform field source guidance from the template modal
  platformRequests?: Array<{
    platform: string;
    fieldSources?: Record<string, string[]>; // field -> preferred source domains/urls in order
    customPrompt?: string;
  }>;
  // Optional: top-level sources list from the template (domains/urls)
  templateSources?: string[];
  options?: {
    useScraping?: boolean; // whether to scrape sources before generation
  };
  metadata: {
    totalProducts: number;
    estimatedTimeMinutes: number;
    createdAt: string;
  };
}

export interface GeneratedPlatformSpecificDetails {
  title?: string;
  description?: string;
  price?: number;
  compareAtPrice?: number;
  categorySuggestion?: string;
  tags?: string[] | string;
  brand?: string;
  condition?: string;
  // Platform-specific, open-ended structure allowed
  [key: string]: any;
}

export interface GenerateJobResult {
  productIndex: number;
  productId?: string;
  variantId?: string;
  platforms: Record<string, GeneratedPlatformSpecificDetails>;
  sourceImageUrl: string;
  processingTimeMs: number;
  source?: 'ai_generated' | 'scraped_content' | 'hybrid';
  error?: string;
}

export interface GenerateJobStatus {
  jobId: string;
  userId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  currentStage:
    | 'Preparing'
    | 'Fetching sources'
    | 'Scraping sources'
    | 'Generating details'
    | 'Saving drafts'
    | 'Ready';
  progress: {
    totalProducts: number;
    completedProducts: number;
    currentProductIndex?: number;
    failedProducts: number;
    stagePercentage: number;
  };
  results: GenerateJobResult[];
  summary?: {
    totalProducts: number;
    completed: number;
    failed: number;
    averageProcessingTimeMs?: number;
  };
  error?: string;
  startedAt: string;
  completedAt?: string;
  estimatedCompletionAt?: string;
  updatedAt: string;
}




