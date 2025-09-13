export interface RegenerateJobData {
  type: 'regenerate-job';
  jobId: string;
  userId: string;
  /** Optional: source generate job to pull Firecrawl/scraped context from */
  generateJobId?: string;
  products: Array<{
    productIndex: number;
    productId: string;
    variantId?: string;
    /** What to regenerate */
    regenerateType: 'entire_platform' | 'specific_fields';
    targetPlatform?: string; // e.g., 'shopify', 'amazon', 'ebay'
    targetFields?: string[]; // e.g., ['title', 'description', 'price', 'tags']
    /** Link back to a previous generate job for scraped context */
    sourceJobId?: string; // Reference to previous firecrawl/generate job
    /** Freeform instruction from user for style/changes */
    customPrompt?: string;
    /** Optional inline user instruction for this product */
    userQuery?: string;
    /** Thread/conversation id to accumulate chat-style edits */
    conversationId?: string;
    /** Product images for context */
    imageUrls?: string[];
  }>;
  options?: {
    useExistingScrapedData?: boolean; // Use data from sourceJobId / generateJobId
    enhanceWithGroq?: boolean;
    overwriteExisting?: boolean; // Overwrite existing generated content
    businessTemplate?: string;
  };
  metadata: {
    totalProducts: number;
    estimatedTimeMinutes: number;
    createdAt: string;
  };
}

export interface RegenerateJobResult {
  productIndex: number;
  productId: string;
  variantId?: string;
  regenerateType: 'entire_platform' | 'specific_fields';
  targetPlatform?: string;
  targetFields?: string[];
  userQuery?: string;
  conversationId?: string;
  platforms: Record<string, {
    title?: string;
    description?: string;
    price?: number;
    compareAtPrice?: number;
    tags?: string[];
    category?: string;
    brand?: string;
    condition?: string;
    // Platform-specific fields
    [key: string]: any;
  }>;
  source: 'ai_generated' | 'scraped_content' | 'hybrid';
  sourceUrls?: string[];
  processingTimeMs: number;
  error?: string;
}

export interface RegenerateJobStatus {
  jobId: string;
  userId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  currentStage: 
    | 'Preparing'
    | 'Fetching source data'
    | 'Analyzing requirements'
    | 'Generating content'
    | 'Updating products'
    | 'Ready';
  progress: {
    totalProducts: number;
    completedProducts: number;
    currentProductIndex?: number;
    failedProducts: number;
    stagePercentage: number; // 0-100 for current stage
  };
  results: RegenerateJobResult[];
  summary?: {
    totalProducts: number;
    completed: number;
    failed: number;
    averageProcessingTimeMs?: number;
    platformsRegenerated: string[];
  };
  error?: string;
  startedAt: string;
  completedAt?: string;
  estimatedCompletionAt?: string;
  updatedAt: string;
}

// Input validation DTOs
export interface RegenerateProductInput {
  productIndex: number;
  productId: string;
  variantId?: string;
  regenerateType: 'entire_platform' | 'specific_fields';
  targetPlatform?: string;
  targetFields?: string[];
  sourceJobId?: string;
  userQuery?: string;
  conversationId?: string;
  customPrompt?: string;
  imageUrls?: string[];
}

export interface RegenerateJobOptions {
  useExistingScrapedData?: boolean;
  enhanceWithGroq?: boolean;
  overwriteExisting?: boolean;
  businessTemplate?: string;
}

