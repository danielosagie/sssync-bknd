# SSSync AI - End-to-End Testing Guide

This guide details how to test the complete AI-powered product recognition and ingestion flow, from a quick database check to a deep web search and automated content generation.

## 🚀 Core User Flow to Test

The primary scenario we'll test is:
1.  **Initial Check**: The user provides an image or text. The system first checks its own database for a high-confidence match.
2.  **Fallback to Deep Search**: If no high-confidence match is found, the system uses a powerful web search to find potential product pages.
3.  **User Validation**: The user confirms the correct product from the web search results.
4.  **Scrape & Generate**: The system scrapes the validated product page and uses AI to generate a complete, structured product listing.

---

## 🛠️ Testing Steps & API Calls

Follow these steps using `cURL` or any API client (like Postman or Insomnia). Replace `YOUR_BACKEND_URL` and `YOUR_JWT_TOKEN` with your actual deployment values.

### Step 1: Quick Recognition (Internal DB Check)

First, simulate a user providing an image or text query. This endpoint performs a fast, multi-modal vector search against your internal `ProductEmbeddings` table and uses the AI reranker for high-quality scoring.

**API Endpoint**: `POST /products/recognize/enhanced`

```bash
curl -X POST YOUR_BACKEND_URL/products/recognize/enhanced \
-H "Authorization: Bearer YOUR_JWT_TOKEN" \
-H "Content-Type: application/json" \
-d '{
  "textQuery": "Vintage Spider-Man Comic Book Issue 300",
  "imageBase64": "YOUR_BASE64_ENCODED_IMAGE_STRING",
  "businessTemplate": "comic-book"
}'
```

**Expected Results**:

*   **High-Confidence Match (`confidence: "high"`)**: The flow stops here. The frontend should display the single best match for the user to confirm.
*   **Medium-Confidence Match (`confidence: "medium"`)**: The frontend should display the top 3-5 candidates for the user to choose from.
*   **Low-Confidence Match (`confidence: "low"`)**: This is the trigger for our deep search flow. The frontend should now transition to the **Enhanced Search** screen.

---

### Step 2: Deep Search (Web Search Fallback)

When the initial check fails, the user is presented with the Enhanced Search screen. Here, they can provide a search query and optionally specify which websites to search on.

**API Endpoint**: `POST /products/recognize/deep-search`

```bash
curl -X POST YOUR_BACKEND_URL/products/recognize/deep-search \
-H "Authorization: Bearer YOUR_JWT_TOKEN" \
-H "Content-Type: application/json" \
-d '{
  "query": "Spider-Man Issue 300",
  "searchSites": [
    "ebay.com",
    "mycomicshop.com"
  ],
  "businessTemplate": "comic-book"
}'
```

**How it Works**:
*   The backend takes the `query` and constructs a powerful search string like: `"Spider-Man Issue 300 site:ebay.com OR site:mycomicshop.com"`.
*   It uses the Firecrawl service to execute this search across the web.
*   The endpoint returns a list of raw search results (URLs, titles, snippets).

**Expected Results**:
A JSON array of search results that the frontend will display in a modal for the user to validate.

```json
[
  {
    "title": "Amazing Spider-Man #300 (1988) - 1st App of Venom - eBay",
    "url": "https://www.ebay.com/p/123456789",
    "content": "Find great deals for Amazing Spider-Man #300 (1988) - 1st App of Venom. Shop with confidence on eBay!"
  },
  {
    "title": "Amazing Spider-Man #300 | MyComicShop",
    "url": "https://www.mycomicshop.com/search?TID=12345",
    "content": "The Amazing Spider-Man #300 by David Michelinie and Todd McFarlane. Cover pencils by Todd McFarlane, inks by Todd McFarlane."
  }
]
```

---

### Step 3: Scrape & Generate (User-Validated Generation)

After the user selects the correct link from the Step 2 results, the frontend calls this final endpoint.

**API Endpoint**: `POST /products/recognize/scrape-and-generate`

```bash
curl -X POST YOUR_BACKEND_URL/products/recognize/scrape-and-generate \
-H "Authorization: Bearer YOUR_JWT_TOKEN" \
-H "Content-Type: application/json" \
-d '{
  "urls": [
    "https://www.ebay.com/p/123456789"
  ],
  "contextQuery": "Spider-Man Issue 300",
  "businessTemplate": "comic-book"
}'
```

**How it Works**:
*   The backend receives the user-validated URL(s).
*   It uses `Firecrawl` to scrape the full content (Markdown and metadata) from each URL.
*   The scraped content is then passed to the `AiGenerationService`, which uses a `Groq` LLM (Llama3-70b) with a specialized prompt to convert the messy web data into a clean, structured product listing.

**Expected Results**:
A single, clean JSON object representing the final, AI-generated product data, ready to be displayed in the listing form.

```json
{
  "source": "deep_search_generation",
  "confidence": 0.98,
  "data": {
    "title": "The Amazing Spider-Man #300 (First appearance of Venom)",
    "description": "This is a key issue from May 1988, featuring the first full appearance of the symbiote Venom. Written by David Michelinie with iconic cover and interior art by Todd McFarlane.",
    "price": 850.00,
    "brand": "Marvel Comics",
    "specifications": {
      "Publisher": "Marvel",
      "Issue Number": "300",
      "Era": "Copper Age (1984-1991)",
      "Grade": "Ungraded"
    },
    "tags": ["Spider-Man", "Venom", "Todd McFarlane", "Key Issue", "Copper Age"]
  },
  "title": "The Amazing Spider-Man #300 (First appearance of Venom)",
  "price": 850,
  "image": "https://example.com/generated_image_url.jpg"
}
```

---

## 🧑‍💻 User-Created Search Templates

Your users can create their own "templates" to streamline the deep search process. A template is simply:
1.  A list of **preferred websites** to search (`searchSites`).
2.  A set of **instructions** for the AI agent (`searchPrompt` in the database).

When a user selects a template on the `EnhancedSearchScreen`, the frontend automatically populates the `searchSites` in the `deep-search` API call and uses the instructions to guide the `scrape-and-generate` AI. This powerful feature lets your users customize and optimize their own data ingestion workflows.

This end-to-end process provides a robust solution for identifying unknown products, leveraging external data sources with user validation, and using AI to automate the tedious process of creating a product listing. 