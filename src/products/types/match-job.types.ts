export interface MatchJobData {
  type: 'match-job';
  jobId: string;
  userId: string;
  products: Array<{
    productIndex: number;
    productId?: string;
    images: Array<{
      url?: string;
      base64?: string;
      metadata?: any;
    }>;
    textQuery?: string;
  }>;
  options?: {
    useReranking?: boolean; // Default: true
    vectorSearchLimit?: number; // Default: 7
  };
  metadata: {
    totalProducts: number;
    estimatedTimeMinutes: number;
    createdAt: string;
    batchSize?: number; // Internal batching size
    targetSites?: string[]; // normalized hostnames for site: filters
  };
}

export interface MatchJobResult {
  productIndex: number;
  productId: string;
  variantId: string;
  serpApiData: any; // Full SerpAPI response
  rerankedResults: Array<{
    rank: number;
    score: number;
    serpApiIndex: number; // Index in original SerpAPI results
    title: string;
    link: string;
    imageUrl?: string;
    snippet?: string;
    embeddingId?: string; // Reference to stored embedding
  }>;
  confidence: 'high' | 'medium' | 'low';
  vectorSearchFoundResults: boolean;
  originalTargetImage: string;
  processingTimeMs: number;
  timing: {
    quickScanMs: number;
    serpApiMs: number;
    embeddingMs: number;
    vectorSearchMs: number;
    rerankingMs: number;
    totalMs: number;
  };
  error?: string;
}

export interface MatchJobStatus {
  jobId: string;
  userId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  currentStage: 'Indexing web pages' | 'Found products...' | 'Cleaning product list' | 'Pulling images' | 'Creating grid' | 'Ready to review';
  progress: {
    totalProducts: number;
    completedProducts: number;
    currentProductIndex?: number;
    failedProducts: number;
    stagePercentage: number; // 0-100 for current stage
  };
  results: MatchJobResult[];
  summary?: {
    highConfidenceCount: number;
    mediumConfidenceCount: number; 
    lowConfidenceCount: number;
    totalEmbeddingsStored: number;
    averageProcessingTimeMs: number;
  };
  error?: string;
  startedAt: string;
  completedAt?: string;
  estimatedCompletionAt?: string;
  updatedAt: string;
}

export interface CompareResultsInput {
  targetImage: string; // URL or base64 of original product image
  serpApiResults: any[]; // SerpAPI search results
  productId: string;
  ProductVariantId: string;
  userId: string;
  options?: {
    vectorSearchLimit?: number; // Default: 7
    storeEmbeddings?: boolean; // Default: true
    useReranking?: boolean; // Default: true
  };
}

export interface CompareResultsOutput {
  rerankedResults: Array<{
    rank: number;
    score: number;
    serpApiIndex: number;
    title: string;
    link: string;
    imageUrl?: string;
    snippet?: string;
    embeddingId?: string;
  }>;
  confidence: 'high' | 'medium' | 'low';
  vectorSearchFoundResults: boolean;
  totalEmbeddingsStored: number;
  processingTimeMs: number;
  metadata: {
    targetImageEmbeddingId?: string;
    vectorSearchResults: number;
    rerankerInputCount: number;
    embeddingTimeMs?: number;
    vectorSearchTimeMs?: number;
    rerankingTimeMs?: number;
  };
} 