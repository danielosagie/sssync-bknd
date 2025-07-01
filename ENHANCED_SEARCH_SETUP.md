# Enhanced Search & Deep Search Feature Documentation

## Overview

The Enhanced Search feature transforms sssync from a basic product listing tool into the "Google of ecommerce product data" by implementing AI-powered web scraping, vector embeddings, and deep product intelligence. This feature creates a competitive moat by building the largest, cleanest product dataset with the easiest listing process.

## Strategic Vision

### The "Google of Ecommerce" Concept
- **Replace SerpAPI dependency** with custom image recognition and vector database
- **Create industry-specific templates** (comic books, electronics, fashion, etc.)
- **Implement human-in-the-loop verification** for data quality
- **Build AI agent chat interface** for complex product searches
- **Establish the largest, cleanest product dataset** with easiest listing process

### Competitive Moat Strategy
1. **Data Quality**: Human-verified product information
2. **Speed**: Instant product recognition and data population
3. **Accuracy**: AI-enhanced data extraction with web scraping
4. **Completeness**: Multiple data sources combined intelligently
5. **Templates**: Industry-specific optimization

## System Architecture

### Core Components

```
┌─────────────────────────────────────────────────────────────┐
│                    Enhanced Search Flow                     │
├─────────────────────────────────────────────────────────────┤
│  1. Multiple Input Methods                                  │
│     • Photo/Image Upload                                    │
│     • Barcode Scanning                                      │
│     • Text Search                                           │
│     • URL Paste                                            │
│                                                             │
│  2. Smart Detection & Routing                              │
│     • Auto-detect input type                               │
│     • Route to appropriate processor                       │
│                                                             │
│  3. Inventory Check                                         │
│     • Search existing products first                       │
│     • Vector similarity matching                           │
│                                                             │
│  4. Web Enhancement                                         │
│     • Firecrawl deep search                               │
│     • Extract structured product data                      │
│     • Template-based enhancement                           │
│                                                             │
│  5. Human Verification Loop                                │
│     • Quality assurance                                     │
│     • Data validation                                       │
│     • Continuous improvement                               │
│                                                             │
│  6. Platform Publishing                                     │
│     • Multi-platform optimization                          │
│     • Template-specific formatting                         │
└─────────────────────────────────────────────────────────────┘
```

## Database Schema

### ProductEmbeddings Table
```sql
CREATE TABLE "ProductEmbeddings" (
    "Id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "ProductVariantId" uuid REFERENCES "ProductVariants"("Id") ON DELETE CASCADE,
    "AiGeneratedContentId" uuid REFERENCES "AiGeneratedContent"("Id") ON DELETE SET NULL,
    "SourceType" text NOT NULL, -- 'canonical_title', 'canonical_description', 'visual_features'
    "ContentText" text NOT NULL,
    embedding vector(384) NOT NULL, -- Vector embeddings for similarity search
    "ModelName" text NOT NULL, -- 'all-MiniLM-L6-v2' or custom model
    "CreatedAt" timestamptz NOT NULL DEFAULT now()
);

-- Indexes for performance
CREATE INDEX idx_productembeddings_variant_id ON "ProductEmbeddings"("ProductVariantId");
CREATE INDEX idx_productembeddings_embedding ON "ProductEmbeddings" 
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

### AI Usage Tracking
```sql
CREATE TABLE "AiUsageTracking" (
    "Id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "UserId" uuid REFERENCES "Users"("Id") ON DELETE CASCADE,
    "ServiceType" text NOT NULL, -- 'embedding', 'firecrawl', 'vision', 'generation'
    "RequestType" text NOT NULL, -- 'search', 'extract', 'analyze', 'generate'
    "TokensUsed" integer,
    "CostUsd" decimal(10,4),
    "ResponseTime" integer, -- milliseconds
    "Success" boolean NOT NULL,
    "ErrorMessage" text,
    "Metadata" jsonb,
    "CreatedAt" timestamptz NOT NULL DEFAULT now()
);
```

### Search Templates
```sql
CREATE TABLE "SearchTemplates" (
    "Id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "Name" text UNIQUE NOT NULL, -- 'comic_books', 'electronics', 'fashion'
    "DisplayName" text NOT NULL,
    "Description" text,
    "SearchPrompt" text NOT NULL,
    "ExtractionSchema" jsonb NOT NULL,
    "ValidationRules" jsonb,
    "IsActive" boolean NOT NULL DEFAULT true,
    "CreatedAt" timestamptz NOT NULL DEFAULT now(),
    "UpdatedAt" timestamptz NOT NULL DEFAULT now()
);
```

## Backend Services

### 1. EmbeddingService (`src/embedding/embedding.service.ts`)

Handles vector embeddings for product similarity matching:

```typescript
interface EmbeddingService {
  // Generate embeddings for text content
  generateEmbedding(text: string, modelName?: string): Promise<number[]>;
  
  // Store embeddings in database
  storeProductEmbedding(params: {
    productVariantId: string;
    sourceType: string;
    contentText: string;
    embedding: number[];
    modelName: string;
  }): Promise<void>;
  
  // Batch process embeddings
  batchGenerateEmbeddings(items: EmbeddingItem[]): Promise<EmbeddingResult[]>;
}
```

**Key Features:**
- Uses `all-MiniLM-L6-v2` model for 384-dimension embeddings
- Supports multiple content types (title, description, visual features)
- Optimized for product similarity matching
- Batch processing for efficiency

### 2. VectorSearchService (`src/embedding/vector-search.service.ts`)

Provides fast similarity search capabilities:

```typescript
interface VectorSearchService {
  // Find similar products by embedding
  findSimilarProducts(params: {
    embedding: number[];
    limit?: number;
    threshold?: number;
    userId?: string;
  }): Promise<SimilarProduct[]>;
  
  // Search by text (generates embedding internally)
  searchByText(params: {
    query: string;
    limit?: number;
    userId?: string;
  }): Promise<SimilarProduct[]>;
  
  // Hybrid search (vector + keyword)
  hybridSearch(params: {
    query: string;
    embedding?: number[];
    filters?: SearchFilters;
  }): Promise<SimilarProduct[]>;
}
```

**Key Features:**
- Cosine similarity matching
- Configurable similarity thresholds
- User-scoped searches
- Performance optimized with pgvector

### 3. FirecrawlService (`src/products/firecrawl.service.ts`)

Intelligent web scraping and data extraction:

```typescript
interface FirecrawlService {
  // Deep research on product URLs
  deepProductResearch(url: string, template?: string): Promise<ProductData>;
  
  // Extract structured data with schemas
  extractWithSchema(params: {
    urls: string[];
    schema: object;
    prompt?: string;
  }): Promise<ExtractedData[]>;
  
  // Template-based extraction
  extractWithTemplate(params: {
    urls: string[];
    templateName: string;
    businessType?: string;
  }): Promise<TemplateResult>;
  
  // Web search and scrape
  searchAndScrape(params: {
    query: string;
    limit?: number;
    scrapeResults?: boolean;
  }): Promise<SearchResult[]>;
}
```

**Key Features:**
- Template-based extraction for different business types
- Schema-driven data extraction
- Deep research capabilities
- Rate limiting and error handling
- Cost tracking

### 4. AI Generation Service Enhanced (`src/products/ai-generation/ai-generation.service.ts`)

Enhanced with web data integration:

```typescript
interface EnhancedAIGenerationService {
  // Generate with web enhancement
  generateWithWebData(params: {
    imageData?: string;
    visualMatches?: VisualMatch[];
    enhancedWebData?: WebScrapedData;
    platforms: string[];
    template?: string;
  }): Promise<GeneratedDetails>;
  
  // Template-specific generation
  generateWithTemplate(params: {
    templateName: string;
    sourceData: ProductData;
    platforms: string[];
  }): Promise<TemplateDetails>;
}
```

## Frontend Components

### 1. Enhanced Search Interface (`src/components/EnhancedSearchInterface.tsx`)

ChatGPT-style interface with multiple input methods:

**Features:**
- Text input with auto-detection (URL, barcode, search query)
- Image upload with drag-and-drop
- Search pills showing active searches
- Results display with confidence scores
- Integration with existing backend APIs

**Usage:**
```typescript
<EnhancedSearchInterface
  onProductFound={(product) => handleProductSelection(product)}
  onSearchStart={() => setSearching(true)}
  onSearchComplete={() => setSearching(false)}
  placeholder="Search by photo, barcode, URL, or description..."
/>
```

### 2. Mobile Flow Integration

Enhanced `AddListingScreen.tsx` with new stages:

```typescript
enum ListingStage {
  EnhancedSearch = 'ENHANCED_SEARCH',     // New: Enhanced search
  PlatformSelection = 'PLATFORM_SELECTION',
  ImageInput = 'IMAGE_INPUT',
  Analyzing = 'ANALYZING',
  VisualMatch = 'VISUAL_MATCH',
  EnhancingData = 'ENHANCING_DATA',       // New: Web scraping
  Generating = 'GENERATING',
  FormReview = 'FORM_REVIEW',
  Publishing = 'PUBLISHING',
}
```

**Key Functions:**
- `enhanceDataFromMatch()`: Automatically scrape selected visual match URLs
- `handleSelectMatchForGeneration()`: Enhanced to trigger web data collection
- Loading states for enhanced data processing

## Business Templates

### Template System Architecture

Templates provide industry-specific optimization for different business types:

#### 1. Comic Books Template
```json
{
  "name": "comic_books",
  "schema": {
    "title": "string",
    "issue_number": "string",
    "series": "string",
    "publisher": "string",
    "year": "number",
    "condition": "string",
    "variant_cover": "boolean",
    "key_issues": "array",
    "price_guide_value": "number"
  },
  "extractionPrompt": "Extract comic book details including series, issue number, publisher, condition, and any key issue significance.",
  "searchKeywords": ["comic", "issue", "series", "publisher", "condition", "variant"]
}
```

#### 2. Electronics Template
```json
{
  "name": "electronics",
  "schema": {
    "brand": "string",
    "model": "string",
    "specifications": "object",
    "condition": "string",
    "warranty_info": "string",
    "power_requirements": "string",
    "dimensions": "object",
    "weight": "number"
  },
  "extractionPrompt": "Extract electronics specifications, model numbers, brand, condition, and technical details.",
  "searchKeywords": ["brand", "model", "specs", "condition", "warranty"]
}
```

#### 3. Fashion Template
```json
{
  "name": "fashion",
  "schema": {
    "brand": "string",
    "size": "string",
    "color": "string",
    "material": "string",
    "care_instructions": "string",
    "season": "string",
    "style": "string",
    "gender": "string"
  },
  "extractionPrompt": "Extract fashion item details including brand, size, color, material, and style information.",
  "searchKeywords": ["brand", "size", "color", "material", "style", "gender"]
}
```

## API Endpoints

### Enhanced Product Search
```typescript
// POST /api/products/enhanced-search
{
  "query"?: string,
  "imageData"?: string,
  "url"?: string,
  "barcode"?: string,
  "template"?: string,
  "limit"?: number
}
```

### Deep Research
```typescript
// POST /api/products/deep-research
{
  "url": string,
  "template"?: string,
  "extractSchema"?: object
}
```

### Generate with Web Enhancement
```typescript
// POST /api/products/generate-details-enhanced
{
  "imageData"?: string,
  "visualMatches"?: VisualMatch[],
  "enhancedWebData"?: WebScrapedData,
  "platforms": string[],
  "template"?: string
}
```

## Setup Instructions

### 1. Database Setup
Run migrations in order:
```bash
# Core embedding support
psql -d your_db -f migrations/create-product-embeddings.sql

# AI usage tracking
psql -d your_db -f migrations/create-ai-usage-tracking.sql

# Search templates
psql -d your_db -f migrations/create-search-templates.sql

# Vector functions
psql -d your_db -f migrations/create-vector-functions.sql
```

### 2. Environment Variables
```env
# Firecrawl Configuration
FIRECRAWL_API_KEY=your_firecrawl_api_key
FIRECRAWL_BASE_URL=https://api.firecrawl.dev

# Embedding Model Configuration
EMBEDDING_MODEL_NAME=all-MiniLM-L6-v2
EMBEDDING_DIMENSIONS=384

# AI Services
OPENAI_API_KEY=your_openai_key
ANTHROPIC_API_KEY=your_anthropic_key

# Vector Search Configuration
VECTOR_SIMILARITY_THRESHOLD=0.7
MAX_SIMILAR_PRODUCTS=10
```

### 3. Service Dependencies
```bash
# Install required packages
npm install @supabase/supabase-js
npm install @firecrawl/sdk
npm install sentence-transformers  # For embeddings
npm install pgvector  # For vector operations
```

### 4. Initialize Templates
```bash
# Seed default templates
npm run seed:templates
```

## Performance Optimization

### 1. Vector Index Tuning
```sql
-- Optimize vector index for your data size
CREATE INDEX idx_productembeddings_embedding_optimized ON "ProductEmbeddings" 
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 1000);

-- For larger datasets (>100k products)
CREATE INDEX idx_productembeddings_embedding_hnsw ON "ProductEmbeddings" 
    USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
```

### 2. Caching Strategy
- **Redis caching** for frequent embedding queries
- **CDN caching** for scraped product images
- **Database connection pooling** for high concurrency

### 3. Rate Limiting
- **Firecrawl API**: 100 requests/minute
- **Embedding generation**: 1000 requests/minute
- **Web searches**: 50 requests/minute per user

## Human-in-the-Loop Verification

### Quality Assurance Workflow
1. **Automated Data Extraction**: AI processes product data
2. **Confidence Scoring**: System assigns confidence levels
3. **Human Review Queue**: Low-confidence items flagged for review
4. **Expert Verification**: Domain experts validate and correct data
5. **Feedback Loop**: Corrections fed back to improve AI accuracy

### Verification Interface
- Web dashboard for reviewers
- Batch review capabilities
- Quality metrics tracking
- Reviewer performance analytics

## Monitoring & Analytics

### Key Metrics
- **Search Accuracy**: Percentage of successful product matches
- **Data Quality Score**: Human verification success rate
- **Response Time**: Average search and extraction times
- **Cost Per Search**: AI service costs per operation
- **User Satisfaction**: Search result relevance scores

### Monitoring Tools
- **Application Performance Monitoring**: Track service response times
- **Cost Analytics**: Monitor AI service spending
- **Quality Dashboards**: Track data accuracy over time
- **User Analytics**: Search pattern analysis

## Future Enhancements

### Phase 2: AI Agent Chat Interface
- Natural language product queries
- Multi-turn conversations
- Context-aware recommendations
- Integration with business templates

### Phase 3: Predictive Analytics
- Market trend analysis
- Price optimization suggestions
- Inventory recommendations
- Seasonal demand forecasting

### Phase 4: Marketplace Intelligence
- Competitive analysis
- Price monitoring
- Listing optimization
- Cross-platform insights

## Troubleshooting

### Common Issues

#### 1. Slow Vector Searches
```sql
-- Check index usage
EXPLAIN ANALYZE SELECT * FROM "ProductEmbeddings" 
ORDER BY embedding <-> '[your_vector]' LIMIT 10;

-- Rebuild index if needed
REINDEX INDEX idx_productembeddings_embedding;
```

#### 2. High API Costs
- Implement more aggressive caching
- Optimize batch processing
- Use template-specific rate limits

#### 3. Low Search Accuracy
- Retrain embedding models with domain-specific data
- Improve product data quality
- Enhance template specifications

## Contributing

### Adding New Templates
1. Define schema in `migrations/create-search-templates.sql`
2. Implement extraction logic in `FirecrawlService`
3. Add frontend template selection
4. Create test cases
5. Document template usage

### Improving AI Accuracy
1. Collect feedback on search results
2. Analyze common failure patterns
3. Enhance prompt engineering
4. Update training datasets
5. A/B test improvements

## Security Considerations

### Data Protection
- Encrypt sensitive product data
- Implement access controls
- Audit search queries
- Protect API keys
- Secure embedding vectors

### Rate Limiting
- Per-user request limits
- API key management
- Cost monitoring alerts
- Abuse detection
- Service degradation protection

---

This enhanced search system transforms sssync into a competitive ecommerce intelligence platform, providing unmatched product data quality and user experience while building sustainable competitive advantages through data network effects and AI optimization. 