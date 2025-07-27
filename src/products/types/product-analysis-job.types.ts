export interface ProductAnalysisJobData {
  type: 'product-analysis';
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
    enhanceWithGroq?: boolean;
    businessTemplate?: string;
    fallbackSearchAddresses?: string[];
  };
  metadata: {
    totalProducts: number;
    estimatedTimeMinutes: number;
    createdAt: string;
  };
}

export interface ProductAnalysisResult {
  productIndex: number;
  productId?: string;
  primaryImage: string;
  textQuery?: string;
  databaseMatches: any[];
  externalMatches: any[];
  confidence: 'high' | 'medium' | 'low';
  processingTimeMs: number;
  recommendedAction: 'show_database_match' | 'show_external_matches' | 'manual_entry';
  serpApiAnalysis?: {
    analysisId: string;
    rawData: string;
    metadata: any;
  } | null;
  error?: string;
}

export interface ProductAnalysisJobStatus {
  jobId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  progress: {
    completed: number;
    total: number;
    failed: number;
    currentProduct?: number;
  };
  results: ProductAnalysisResult[];
  summary: {
    totalProducts: number;
    highConfidenceCount: number;
    mediumConfidenceCount: number;
    lowConfidenceCount: number;
    estimatedCostPerProduct: number;
    totalProcessingTimeMs: number;
  };
  error?: string;
  startedAt?: string;
  completedAt?: string;
  estimatedCompletionAt?: string;
} 