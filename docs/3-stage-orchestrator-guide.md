# 🎯 Flexible Product Recognition System Guide

This guide shows you how to use the **NEW Flexible Product Recognition System** that handles any sites, images, links, or text queries gracefully.

## Overview

The new system is **completely flexible** and works with:

- **🔗 Any Links** - Submit any URL for instant scraping + vector search
- **🖼️ Any Images** - Upload images from any source
- **📝 Any Text** - Search with any text query
- **🌐 Any Target Sites** - Specify any sites to prioritize (amazon.com, previewsworld.com, etc.)
- **⚡ Graceful Fallbacks** - Always returns useful results

## New Architecture

```
Input (Links/Images/Text) → Quick Scan → Vector Search → Reranking → Generate from Any Sites → Products
```

**Key Changes:**
- ❌ No more rigid "business templates" 
- ✅ Flexible target sites (`["amazon.com", "previewsworld.com"]`)
- ✅ Link submission for instant recognition
- ✅ Proper embedding storage and retrieval
- ✅ Graceful fallbacks for all cases

---

## 🔥 NEW: Quick Scan Endpoint

**Endpoint:** `POST /products/orchestrate/quick-scan`

This is your **main endpoint** - it handles everything flexibly!

### Example 1: Link Submission (Your Use Case!)

```json
{
  "links": ["https://previewsworld.com/Catalog/JUN23040C"],
  "textQuery": "Green Lantern War Journal Vol 1 Contagion",
  "targetSites": ["previewsworld.com", "amazon.com"],
  "useReranker": true
}
```

### Example 2: Image + Text with Target Sites

```json
{
  "images": [
    {
      "url": "https://example.com/comic-cover.jpg"
    }
  ],
  "textQuery": "DC Comics Green Lantern",
  "targetSites": ["amazon.com", "ebay.com", "previewsworld.com"],
  "useReranker": true
}
```

### Example 3: Bulk Mode

```json
{
  "links": [
    "https://previewsworld.com/comic1",
    "https://previewsworld.com/comic2",
    "https://amazon.com/product/xyz"
  ],
  "textQuery": "Comic book collection",
  "targetSites": ["previewsworld.com", "amazon.com"],
  "useReranker": true
}
```

### Response:

```json
{
  "results": [
    {
      "sourceIndex": 0,
      "sourceType": "link",
      "matches": [
        {
          "title": "Green Lantern: War Journal Vol. 1 Contagion",
          "description": "DC Comics series...",
          "confidence": 0.92,
          "price": 4.99,
          "source": "vector_database"
        }
      ],
      "confidence": "high",
      "processingTimeMs": 1200
    }
  ],
  "totalProcessingTimeMs": 1200,
  "overallConfidence": "high",
  "recommendedAction": "use_top_matches"
}
```

---

## 🚀 NEW: Flexible Generate Endpoint

**Endpoint:** `POST /products/orchestrate/generate-flexible`

Takes any sources and generates platform-specific data using any target sites.

### Example Request (Your Previewsworld Use Case):

```json
{
  "sources": [
    {
      "type": "link",
      "data": "https://previewsworld.com/Catalog/JUN23040C",
      "selectedMatch": {
        "title": "Green Lantern: War Journal Vol. 1 Contagion",
        "description": "DC Comics series...",
        "price": 4.99
      }
    }
  ],
  "targetSites": ["previewsworld.com", "amazon.com"],
  "platforms": [
    {
      "name": "shopify",
      "useScrapedData": true,
      "customPrompt": "Generate comic book listing optimized for collectors"
    },
    {
      "name": "ebay",
      "useScrapedData": false,
      "customPrompt": "Create auction-style description with collectible value focus"
    }
  ]
}
```

### Response:

```json
{
  "generatedProducts": [
    {
      "sourceIndex": 0,
      "platforms": {
        "shopify": {
          "title": "Green Lantern: War Journal Vol. 1 - Contagion",
          "description": "From PreviewsWorld: This thrilling DC Comics series...",
          "price": 4.99,
          "images": ["https://previewsworld.com/cover.jpg"],
          "source": "scraped_content"
        },
        "ebay": {
          "title": "🔥 GREEN LANTERN WAR JOURNAL VOL 1 CONTAGION - DC COMICS 🔥",
          "description": "RARE COMIC BOOK! Perfect for collectors...",
          "price": 6.99,
          "source": "ai_generated"
        }
      },
      "scrapedData": [
        {
          "url": "https://previewsworld.com/Catalog/JUN23040C",
          "content": {
            "title": "Green Lantern: War Journal Vol. 1 Contagion",
            "description": "Written by Phillip Kennedy Johnson...",
            "price": "$4.99"
          },
          "title": "Product from PreviewsWorld"
        }
      ]
    }
  ],
  "storageResults": {
    "productsCreated": 1,
    "variantsCreated": 1,
    "embeddingsStored": 2
  }
}
```

---

## 💡 Frontend Integration

### React/TypeScript Example:

```typescript
class FlexibleProductRecognition {
  private baseUrl = '/api/products/orchestrate';
  
  // Quick scan any source
  async quickScan(input: {
    links?: string[];
    images?: Array<{url?: string; base64?: string}>;
    textQuery?: string;
    targetSites?: string[];
    useReranker?: boolean;
  }) {
    const response = await fetch(`${this.baseUrl}/quick-scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    });
    
    return response.json();
  }
  
  // Generate from any sources
  async generateFlexible(input: {
    sources: Array<{
      type: 'image' | 'link' | 'text';
      data: any;
      selectedMatch?: any;
    }>;
    targetSites: string[];
    platforms: Array<{
      name: string;
      useScrapedData?: boolean;
      customPrompt?: string;
    }>;
  }) {
    const response = await fetch(`${this.baseUrl}/generate-flexible`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    });
    
    return response.json();
  }
}
```

---

## 🎯 Your Comic Book Use Case - Complete Example

### Step 1: Quick Scan a PreviewsWorld Link

```typescript
const scanner = new FlexibleProductRecognition();

const scanResult = await scanner.quickScan({
  links: ["https://previewsworld.com/Catalog/JUN23040C"],
  textQuery: "Green Lantern War Journal Vol 1 Contagion",
  targetSites: ["previewsworld.com", "amazon.com", "ebay.com"],
  useReranker: true
});

console.log('Scan Results:', scanResult);
// Returns matches from your vector database + reranked results
```

### Step 2: Generate Platform-Specific Listings

```typescript
const generateResult = await scanner.generateFlexible({
  sources: [
    {
      type: 'link',
      data: 'https://previewsworld.com/Catalog/JUN23040C',
      selectedMatch: scanResult.results[0].matches[0] // Use top match
    }
  ],
  targetSites: ['previewsworld.com'], // Your custom prompt sites
  platforms: [
    {
      name: 'shopify',
      useScrapedData: true,
      customPrompt: 'Generate comic book listing for collectors with detailed information'
    },
    {
      name: 'amazon',
      useScrapedData: true,
      customPrompt: 'Create Amazon-compliant comic book listing with specifications'
    }
  ]
});

console.log('Generated Products:', generateResult);
// Returns platform-specific listings with PreviewsWorld data!
```

---

## 🔄 How It Works Behind The Scenes

### 1. **Flexible Input Processing**
- **Links**: Scrapes with Firecrawl → Generates embeddings → Searches vector DB
- **Images**: Generates image embeddings → Searches vector DB
- **Text**: Generates text embeddings → Searches vector DB

### 2. **Smart Vector Search**
- Uses your **AI server** for embeddings
- Stores embeddings in your **PostgreSQL database**
- Searches existing product embeddings for matches

### 3. **AI Reranking**
- Uses your **Qwen3 Reranker** for better candidate scoring
- Considers target sites in ranking logic
- Returns confidence scores

### 4. **Flexible Generation**
- **Firecrawl** searches Google with your target sites: `"Green Lantern" (site:previewsworld.com OR site:amazon.com)`
- Scrapes matching results from your specified sites
- Uses **AI generation** to create platform-specific content
- **Stores embeddings** for future searches

### 5. **Graceful Fallbacks**
- No vector matches → External search with Firecrawl
- No external results → AI-generated content
- Always returns useful results

---

## 🎊 Key Benefits

✅ **Completely Flexible** - Any sites, any inputs, any outputs
✅ **Proper Embedding Storage** - Builds your vector database automatically  
✅ **Smart Fallbacks** - Never fails, always returns something useful
✅ **Target Site Integration** - Your previewsworld.com use case works perfectly
✅ **Bulk Mode Support** - Process multiple items at once
✅ **AI Server Integration** - Uses your Qwen3 embedding + reranker services
✅ **Platform Agnostic** - Generate for any marketplace (Shopify, Amazon, eBay, etc.)

Perfect for your flexible, real-world use cases! 🚀 