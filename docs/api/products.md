# Products API Documentation

## Overview
This document outlines the API endpoints available for managing products, including AI-powered analysis and generation, and integration with platforms like Shopify.

## Authentication
All endpoints require authentication using a Supabase Auth token provided in the `Authorization` header:
```
Authorization: Bearer <supabase-auth-token>
```

## Rate Limiting
Specific rate limits apply to certain endpoints to ensure fair usage and system stability. Exceeding these limits will result in a `429 Too Many Requests` error.
- **`/products/analyze`**: 5 requests per minute per user.
- **`/products/generate-details`**: 5 requests per minute per user.
- **`/products/shopify/locations`**: 10 requests per minute per user.
- **`/products/shopify/inventory`**: 10 requests per minute per user.
- **`/products/shopify/locations-with-products`**: 10 requests per minute per user.
- **Other product endpoints**: Governed by a global rate limit (e.g., 60 requests per minute per user).

## Core Product Workflow

The typical workflow for creating and listing a product involves:

1.  **Image Analysis (Optional but Recommended):**
    *   Use `POST /products/analyze` with image URIs.
    *   The system analyzes the primary image using AI (e.g., Google Lens via SerpApi) and creates a draft `Product` and `ProductVariant` with initial details derived from the analysis.
    *   The analysis results are stored in `AiGeneratedContent`.
    *   This step consumes an `aiScan` from the user's subscription.
2.  **Detail Generation (Optional):**
    *   Use `POST /products/generate-details` with the `productId`, `variantId` from the previous step, along with image URIs, a cover image index, target platforms, and optionally a selected visual match from the analysis.
    *   The system uses a generative AI model (e.g., Groq Maverick) to create richer product titles, descriptions, and other platform-specific details.
    *   These generated details are also stored in `AiGeneratedContent` and can be used to update the draft `ProductVariant`.
    *   This step also consumes an `aiScan`.
3.  **Saving/Publishing the Listing:**
    *   Use `POST /products/publish` to save the curated product details (title, description, price, images, etc.) to the canonical `Product` and `ProductVariant` records.
    *   If `publishIntent` includes publishing to a platform (e.g., Shopify), this endpoint will also trigger the necessary platform-specific publishing actions asynchronously via the queueing system. *(Further details on direct platform publishing API calls are TBD/can be added here as they are finalized, for now, the example is `POST /products/:id/publish/shopify`)*.

Alternatively, products can be created directly without AI assistance:

*   **Direct Product Creation:** Use `POST /products` to create a `Product` and `ProductVariant` with manually provided data.

## Endpoints

### 1. Analyze Images and Create Draft Product
Analyzes product images using AI (e.g., Google Lens) and creates a draft `Product` and `ProductVariant` with initial details. The analysis result is stored. This endpoint consumes an `aiScan` credit.

```http
POST /products/analyze
```

**Feature Flag:** `aiScans`

**Rate Limit:** 5 requests per minute

#### Request Body
```typescript
{
  "imageUris": string[];  // Array of image URLs to analyze. The first image is considered primary.
}
```

#### Response (200 OK)
```typescript
{
  "product": { // The created draft Product
    "Id": string;
    "UserId": string;
    "Title": string;        // Initially derived from analysis or "Untitled Product"
    "Description": string | null; // Initially derived from analysis
    "IsArchived": boolean;  // Default: false
  };
  "variant": { // The created draft ProductVariant
    "Id": string;
    "ProductId": string;
    "Sku": string;          // Generated based on ProductId or from analysis
    "Title": string;        // Initially derived from analysis or "Untitled Product"
    "Price": number;        // Derived from analysis or 0.00
    "Barcode": string | null;
    "Weight": number | null;
    "WeightUnit": string | null;
    "Options": any | null;
    "Description": string | null; // Matches product description initially
    "CompareAtPrice": number | null;
    "RequiresShipping": boolean | null;
    "IsTaxable": boolean | null;
    "TaxCode": string | null;
    "ImageId": string | null;      // Image associations are handled separately
    "PlatformVariantId": string | null;
    "PlatformProductId": string | null;
  };
  "analysis": { // The stored AI analysis content (if successful)
    "Id": string;
    "ProductId": string;
    "ContentType": string;     // e.g., "product_analysis"
    "SourceApi": string;       // e.g., "serpapi_google_lens"
    "GeneratedText": string;   // JSON string of the raw SerpApiLensResponse
    "Metadata": {
        "searchUrl": string;
        "searchEngine": string;
        "topMatchTitle"?: string;
        "topMatchSource"?: string;
    };
    "IsActive": boolean;       // Typically true for the latest analysis
    "CreatedAt": string;       // ISO 8601 timestamp
    "UpdatedAt": string;       // ISO 8601 timestamp
  } | null; // Null if analysis failed or was skipped (e.g., SerpApi not configured)
}
```

#### Example
```typescript
// Request
const response = await fetch('/products/analyze', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer <YOUR_SUPABASE_TOKEN>',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    imageUris: ['https://example.com/your-product-image.jpg']
  })
});
const data = await response.json();

// Example Response (Success)
{
  "product": {
    "Id": "prod_abc123",
    "UserId": "user_xyz789",
    "Title": "Stylish Red Scarf",
    "Description": "A beautiful red scarf, perfect for all occasions.",
    "IsArchived": false
  },
  "variant": {
    "Id": "var_def456",
    "ProductId": "prod_abc123",
    "Sku": "DRAFT-prod_ab",
    "Title": "Stylish Red Scarf",
    "Price": 19.99,
    "Barcode": null,
    "Weight": null,
    "WeightUnit": null,
    "Options": null,
    "Description": "A beautiful red scarf, perfect for all occasions.",
    "CompareAtPrice": null,
    "RequiresShipping": null,
    "IsTaxable": null,
    "TaxCode": null,
    "ImageId": null,
    "PlatformVariantId": null,
    "PlatformProductId": null
  },
  "analysis": {
    "Id": "ai_ghi789",
    "ProductId": "prod_abc123",
    "ContentType": "product_analysis",
    "SourceApi": "serpapi_google_lens",
    "GeneratedText": "{\"visual_matches\":[{\"title\":\"Red Wool Scarf\", ...}]}",
    "Metadata": {
        "searchUrl": "https://example.com/your-product-image.jpg",
        "searchEngine": "google_lens",
        "topMatchTitle": "Red Wool Scarf"
    },
    "IsActive": true,
    "CreatedAt": "2024-07-30T10:00:00Z",
    "UpdatedAt": "2024-07-30T10:00:00Z"
  }
}
```

### 2. Generate Product Details for Draft
Generates enhanced product details (title, description, platform-specific attributes) for an existing draft product using AI. This endpoint consumes an `aiScan` credit.

```http
POST /products/generate-details
```

**Feature Flag:** `aiScans`

**Rate Limit:** 5 requests per minute

#### Request Body
```typescript
{
  "productId": string;            // ID of the Product created in Step 1
  "variantId": string;            // ID of the ProductVariant created in Step 1
  "imageUris": string[];          // Array of image URLs to provide context for generation
  "coverImageIndex": number;      // Index of the primary image in imageUris array
  "selectedPlatforms": string[];  // Array of target platform slugs (e.g., ["shopify", "amazon"])
  "selectedMatch": {            // Optional: A specific visual match from the initial analysis to guide generation
    "title": string;
    "source": string;
    "price"?: {
      "value": string;
      "currency": string;
    };
    "snippet"?: string;
    // ... other fields from VisualMatch type
  } | null;
}
```

#### Response (200 OK)
```typescript
{
  "generatedDetails": { // Object where keys are platform slugs
    // Example for "shopify"
    "shopify": {
      "title": string;
      "description": string;
      "price": number;
      "vendor"?: string;
      "productType"?: string;
      "tags"?: string[];
      // ... other Shopify specific fields
    },
    // Example for "amazon"
    "amazon": {
      "title": string;
      "description": string;
      "price": number;
      "bulletPoints"?: string[];
      "category"?: string;
      // ... other Amazon specific fields
    }
    // ... other platforms
  } | null; // Null if generation failed
}
```
The generated details are also saved to the `AiGeneratedContent` table and can be used to update the `ProductVariant`.

#### Example
```typescript
// Request
const response = await fetch('/products/generate-details', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer <YOUR_SUPABASE_TOKEN>',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    productId: "prod_abc123",
    variantId: "var_def456",
    imageUris: ["https://example.com/image1.jpg", "https://example.com/image2.jpg"],
    coverImageIndex: 0,
    selectedPlatforms: ["shopify"],
    selectedMatch: null // or provide a selected match from /analyze response
  })
});
const data = await response.json();

// Example Response (Success)
{
  "generatedDetails": {
    "shopify": {
      "title": "Elegant Red Wool Scarf - Limited Edition",
      "description": "Wrap yourself in luxury with our Elegant Red Wool Scarf. Made from the finest merino wool, this scarf offers unparalleled softness and warmth. Its vibrant red hue makes a bold statement, perfect for elevating any outfit. Limited edition design.",
      "price": 24.99,
      "vendor": "YourBrandName",
      "productType": "Apparel & Accessories > Scarves",
      "tags": ["wool", "scarf", "red", "luxury", "limited edition"]
    }
  }
}
```

### 3. Save or Publish Product Listing
Saves the final curated product details to the canonical `Product` and `ProductVariant` records. If the `publishIntent` includes platform publishing, it queues the necessary background jobs.

```http
POST /products/publish
```

**Status:** `202 Accepted` - The request is accepted for processing. The actual saving and publishing happens asynchronously.

#### Request Body
```typescript
{
  "productId": string;
  "variantId": string;
  "publishIntent": "SAVE_DRAFT" | "PUBLISH_TO_PLATFORMS"; // Determines if publishing jobs are queued
  "platformDetails": {
    [platformSlug: string]: { // Platform-specific curated details
      "title": string;
      "description": string;
      "price": number;
      // ... other common and platform-specific fields (e.g., SKU, barcode, options, categories, vendor, tags)
    };
  };
  "media": {
    "imageUris": string[];         // Final list of image URLs in desired order
    "coverImageIndex": number;   // Index of the cover image
    // Potentially video URLs, 3D model URIs in the future
  };
  "selectedPlatformsToPublish": string[] | null; // Array of platform slugs to publish to if intent is PUBLISH_TO_PLATFORMS
}
```

#### Response (202 Accepted)
```typescript
{
  "message": "SAVE_DRAFT request received and processing started." 
  // or "PUBLISH_TO_PLATFORMS request received and processing started."
}
```
This endpoint updates the canonical `Product` and `ProductVariant` tables. If `publishIntent` is `PUBLISH_TO_PLATFORMS`, jobs are enqueued (e.g., via `QueueManager.enqueueJob({ type: 'product-publish', ... })`) to handle platform-specific API calls.

#### Example
```typescript
// Request to save draft
const response = await fetch('/products/publish', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer <YOUR_SUPABASE_TOKEN>',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    productId: "prod_abc123",
    variantId: "var_def456",
    publishIntent: "SAVE_DRAFT",
    platformDetails: {
      "canonical": { // Or a specific platform like "shopify" if that's the primary source of truth for this save
        "title": "Final Product Title",
        "description": "Final product description.",
        "price": 22.50
      }
    },
    media: {
      imageUris: ["https://example.com/final_image1.jpg"],
      coverImageIndex: 0
    },
    selectedPlatformsToPublish: null
  })
});
const data = await response.json(); // { "message": "SAVE_DRAFT request received and processing started." }
```

### 4. Direct Product Creation (Manual)
Creates a new `Product` and `ProductVariant` directly with user-provided data, bypassing AI analysis and generation.

```http
POST /products
```

#### Request Body
```typescript
{
  "userId": string; // The ID of the user creating the product
  "variantData": {  // Data for the initial ProductVariant
    "Sku": string;
    "Title": string;
    "Description"?: string;
    "Price": number;
    "Barcode"?: string;
    "Weight"?: number;
    "WeightUnit"?: "POUNDS" | "KILOGRAMS" | "OUNCES" | "GRAMS"; // Example units
    "Options"?: any; // e.g., { "color": ["Red", "Blue"], "size": ["S", "M"] }
    "CompareAtPrice"?: number;
    "RequiresShipping"?: boolean;
    "IsTaxable"?: boolean;
    "TaxCode"?: string;
    // ... any other relevant fields for ProductVariant
  }
}
```

#### Response (200 OK)
The response structure is similar to the `/products/analyze` endpoint, but the `analysis` field will typically be `null`.
```typescript
{
  "product": { /* ... SimpleProduct structure ... */ };
  "variant": { /* ... SimpleProductVariant structure ... */ };
  "analysis": null;
}
```

#### Example
```typescript
// Request
const response = await fetch('/products', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer <YOUR_SUPABASE_TOKEN>',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    userId: "user_xyz789",
    variantData: {
      Sku: "MANUAL-SKU-001",
      Title: "Manually Created Product",
      Price: 49.99
    }
  })
});
const data = await response.json();
```

## Shopify Specific Endpoints
These endpoints are dedicated to managing product data and inventory related to a connected Shopify store.

**Feature Flag:** Most Shopify endpoints require the `shopify` feature to be enabled for the user's subscription.

### 5. Publish Product to Shopify
Directly creates or updates a product on Shopify. This is a more direct way to publish compared to the general `/products/publish` if Shopify is the explicit target.

```http
POST /products/:id/publish/shopify
```
Where `:id` is the canonical **Product ID**.

**Feature Flag:** `shopify`

#### Request Body
```typescript
{
  "platformConnectionId": string;  // ID of the specific Shopify PlatformConnection
  "locations": Array<{             // Inventory levels for Shopify locations
    "locationId": string;          // Shopify Location GID (e.g., "gid://shopify/Location/12345")
    "quantity": number;
  }>;
  "options"?: {                    // Optional Shopify product settings
    "status"?: "ACTIVE" | "DRAFT" | "ARCHIVED"; // Default: "ACTIVE"
    "vendor"?: string;
    "productType"?: string;
    "tags"?: string[];
  };
}
```
This endpoint will take the canonical product data associated with the given `:id`, map it to Shopify's format (including variants and images), and then create/update it on Shopify using the `ShopifyApiClient`. Inventory is set according to the `locations` array.

#### Response (200 OK or 202 Accepted)
```typescript
{
  "success": boolean;
  "productId": string;      // The Product ID on Shopify (e.g., "gid://shopify/Product/78901")
  "operationId"?: string;   // If the creation is asynchronous on Shopify's side
  "status"?: string;        // Status of the operation
}
```

#### Example
```typescript
// Request
const response = await fetch('/products/prod_abc123/publish/shopify', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer <YOUR_SUPABASE_TOKEN>',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    platformConnectionId: "conn_shopify_123",
    locations: [
      { locationId: "gid://shopify/Location/11111", quantity: 10 },
      { locationId: "gid://shopify/Location/22222", quantity: 5 }
    ],
    options: {
      status: "ACTIVE",
      vendor: "MyBrand"
    }
  })
});
const data = await response.json();
```

### 6. Get Shopify Locations
Retrieves a list of all physical and online locations configured for a connected Shopify store.

```http
GET /products/shopify/locations?platformConnectionId=<platformConnectionId_value>
```

**Feature Flag:** `shopify`
**Rate Limit:** 10 requests per minute

#### Query Parameters
- `platformConnectionId` (required): string - The ID of the Shopify `PlatformConnection`.

#### Response (200 OK)
```typescript
{
  "locations": Array<{ // Array of ShopifyLocationNode
    "id": string;           // Shopify Location GID (e.g., "gid://shopify/Location/12345")
    "name": string;
    "isActive": boolean;
    "shipsInventory": boolean;
    "fulfillsOnlineOrders": boolean;
    // ... other fields from ShopifyLocationNode like address details
  }>;
}
```

#### Example
```typescript
// Request
const response = await fetch('/products/shopify/locations?platformConnectionId=conn_shopify_123', {
  method: 'GET',
  headers: { 'Authorization': 'Bearer <YOUR_SUPABASE_TOKEN>' }
});
const data = await response.json();
```

### 7. Get Shopify Inventory Levels
Fetches current inventory levels for products from a connected Shopify store. Can optionally trigger a fresh sync from Shopify before returning data.

```http
GET /products/shopify/inventory?platformConnectionId=<platformConnectionId_value>&sync=<true_or_false>
```

**Feature Flag:** `shopify`
**Rate Limit:** 10 requests per minute

#### Query Parameters
- `platformConnectionId` (required): string - The ID of the Shopify `PlatformConnection`.
- `sync` (optional): boolean - If `true`, forces a fresh data fetch from Shopify before returning. Defaults to `false`.

#### Response (200 OK)
```typescript
{
  "inventory": Array<{
    "variantId": string;           // Canonical (sssync) ProductVariant ID
    "sku": string;
    "title": string;               // Canonical variant title
    "locations": Array<{
      "locationId": string;        // Shopify Location GID
      "locationName": string;
      "quantity": number;
      "updatedAt": string;         // ISO 8601 timestamp of last update for this level
    }>;
    "productId": string;           // Canonical (sssync) Product ID
    "platformVariantId": string;   // Shopify Variant GID
    "platformProductId": string;   // Shopify Product GID
  }>;
  "lastSyncedAt": string | null;   // ISO 8601 timestamp of the last successful sync with Shopify for this connection
}
```

#### Notes on Syncing:
- When `sync=true`:
    1.  The system fetches product mappings for the connection.
    2.  It calls Shopify API to get current inventory levels for mapped variants.
    3.  Updates `InventoryLevels` table in the local database.
    4.  Updates `PlatformConnections.LastSyncSuccessAt`.
    5.  Returns the freshly aggregated data.
- When `sync=false` (or omitted):
    1.  The system queries the local `InventoryLevels` table.
    2.  Returns data based on the last known sync.

#### Example
```typescript
// Request (fetch cached inventory)
const response = await fetch('/products/shopify/inventory?platformConnectionId=conn_shopify_123', {
  method: 'GET',
  headers: { 'Authorization': 'Bearer <YOUR_SUPABASE_TOKEN>' }
});
const data = await response.json();

// Request (force sync then fetch inventory)
const responseSync = await fetch('/products/shopify/inventory?platformConnectionId=conn_shopify_123&sync=true', {
  method: 'GET',
  headers: { 'Authorization': 'Bearer <YOUR_SUPABASE_TOKEN>' }
});
const dataSync = await responseSync.json();
```

### 8. Get Shopify Locations with Products (Aggregated View)
Provides a convenient aggregated view of Shopify locations, each with a list of products and their inventory quantities at that specific location. Useful for UIs displaying inventory by location.

```http
GET /products/shopify/locations-with-products?platformConnectionId=<platformConnectionId_value>&sync=<true_or_false>
```

**Feature Flag:** `shopify`
**Rate Limit:** 10 requests per minute

#### Query Parameters
- `platformConnectionId` (required): string - The ID of the Shopify `PlatformConnection`.
- `sync` (optional): boolean - If `true`, forces a fresh data fetch from Shopify before returning. Defaults to `false`.

#### Response (200 OK)
```typescript
{
  "locations": Array<{
    "id": string;           // Shopify Location GID
    "name": string;
    "isActive": boolean;
    "products": Array<{
      "variantId": string;  // Canonical (sssync) ProductVariant ID
      "sku": string;
      "title": string;      // Canonical variant title
      "quantity": number;
      "updatedAt": string;  // ISO 8601 timestamp of last update for this level
      "productId": string;  // Canonical (sssync) Product ID
      "platformVariantId": string; // Shopify Variant GID
      "platformProductId": string; // Shopify Product GID
    }>;
  }>;
  "lastSyncedAt": string | null; // ISO 8601 timestamp of the last successful sync
}
```
The `sync` behavior is identical to the `/products/shopify/inventory` endpoint.

#### Example
```typescript
// Request
const response = await fetch('/products/shopify/locations-with-products?platformConnectionId=conn_shopify_123&sync=false', {
  method: 'GET',
  headers: { 'Authorization': 'Bearer <YOUR_SUPABASE_TOKEN>' }
});
const data = await response.json();
```

### 9. Queue Product Sync Job (Example)
This is an example endpoint demonstrating how a product sync job could be queued using the dynamic queue manager. The actual implementation for triggering syncs for specific products or connections would depend on the evolving `SyncEngine` requirements.

```http
POST /products/queue-sync
```

#### Request Body
```typescript
{
  "productId": string; // The ID of the product to sync
}
```
The `userId` is typically derived from the authentication token.

#### Response (200 OK)
```typescript
{
  "success": boolean;
  "message": "Product sync job queued."
}
```
This endpoint would call `QueueManager.enqueueJob({ type: 'product-sync', productId, userId, timestamp: Date.now() });`

## General Error Responses
In addition to specific errors mentioned per endpoint, the API may return common HTTP status codes:

- **400 Bad Request:** The request was malformed (e.g., missing required fields, invalid data types). The response body usually contains a `message` detailing the error.
  ```json
  {
    "statusCode": 400,
    "message": "Invalid image URI provided.",
    "error": "Bad Request"
  }
  ```
- **401 Unauthorized:** Authentication token is missing, invalid, or expired.
  ```json
  {
    "statusCode": 401,
    "message": "Unauthorized",
    "error": "Unauthorized"
  }
  ```
- **403 Forbidden:** The authenticated user does not have permission to perform the action (e.g., feature not enabled for their subscription).
  ```json
  {
    "statusCode": 403,
    "message": "Feature 'aiScans' not enabled for your subscription.",
    "error": "Forbidden"
  }
  ```
- **404 Not Found:** The requested resource (e.g., product, variant, connection) could not be found.
  ```json
  {
    "statusCode": 404,
    "message": "Product with ID prod_nonexistent not found.",
    "error": "Not Found"
  }
  ```
- **429 Too Many Requests:** The user has exceeded the rate limit for the endpoint.
  ```json
  {
    "statusCode": 429,
    "message": "Too Many Requests",
    "error": "Too Many Requests"
  }
  ```
- **500 Internal Server Error:** An unexpected error occurred on the server.
  ```json
  {
    "statusCode": 500,
    "message": "Internal server error",
    "error": "Internal Server Error"
  }
  ```

## Notes on Asynchronous Operations
Several operations, particularly those involving AI processing or third-party platform interactions (like publishing to Shopify), may be handled asynchronously.
- Endpoints like `POST /products/publish` might return a `202 Accepted` status, indicating the request has been queued for processing.
- The status of these background jobs can be tracked through other means (e.g., webhook notifications, polling a job status endpoint - TBD).