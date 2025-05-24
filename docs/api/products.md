# Products API Documentation

## Overview
This document outlines the API endpoints available for managing products, including AI-powered analysis and generation, and integration with platforms like Shopify.

## Authentication
All endpoints require authentication using a Supabase Auth token provided in the `Authorization` header:
```
Authorization: Bearer <supabase-auth-token>
```
The base path for all product-related endpoints is `/api`. For example, an endpoint documented as `POST /products/analyze` should be called as `POST /api/products/analyze`.

## Rate Limiting
Specific rate limits apply to certain endpoints to ensure fair usage and system stability. Exceeding these limits will result in a `429 Too Many Requests` error.
- **`/api/products/analyze`**: 5 requests per minute per user.
- **`/api/products/generate-details`**: 5 requests per minute per user.
- **`/api/products/shopify/locations`**: 10 requests per minute per user.
- **`/api/products/shopify/inventory`**: 10 requests per minute per user.
- **`/api/products/shopify/locations-with-products`**: 10 requests per minute per user.
- **Other product endpoints**: Governed by a global rate limit (e.g., 60 requests per minute per user).

## Core Product Workflow

The typical workflow for creating and listing a product involves:

1.  **Image Analysis (Optional but Recommended):**
    *   Use `POST /api/products/analyze` with image URIs. The user associated with the request is identified via the authentication token.
    *   The system analyzes the primary image using AI (e.g., Google Lens via SerpApi) and creates a draft `Product` and `ProductVariant` with initial details derived from the analysis.
    *   The analysis results are stored in `AiGeneratedContent`.
    *   This step consumes an `aiScan` from the user's subscription.
2.  **Detail Generation (Optional):**
    *   Use `POST /api/products/generate-details` with the `productId`, `variantId` from the previous step, along with image URIs, a cover image index, target platforms, and optionally a selected visual match from the analysis.
    *   The system uses a generative AI model (e.g., Groq Maverick) to create richer product titles, descriptions, and other platform-specific details.
    *   These generated details are also stored in `AiGeneratedContent` and can be used to update the draft `ProductVariant`.
    *   This step also consumes an `aiScan`.
3.  **Saving/Publishing the Listing:**
    *   Use `POST /api/products/publish` to save the curated product details (title, description, price, images, etc.) to the canonical `Product` and `ProductVariant` records.
    *   If `publishIntent` includes publishing to a platform (e.g., Shopify), this endpoint will also trigger the necessary platform-specific publishing actions asynchronously via the queueing system. *(Further details on direct platform publishing API calls are TBD/can be added here as they are finalized, for now, the example is `POST /api/products/:id/publish/shopify`)*.

Alternatively, products can be created directly without AI assistance:

*   **Direct Product Creation:** Use `POST /api/products` to create a `Product` and `ProductVariant` with manually provided data.

## Endpoints

### 1. Analyze Images and Create Draft Product
Analyzes product images using AI (e.g., Google Lens) and creates a draft `Product` and `ProductVariant` with initial details. The analysis result is stored. This endpoint consumes an `aiScan` credit. User identification is derived from the `Authorization` token.

```http
POST /api/products/analyze
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
const response = await fetch('/api/products/analyze', {
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
POST /api/products/generate-details
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
const response = await fetch('/api/products/generate-details', {
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
POST /api/products/publish
```

**Status:** `202 Accepted` - The request is accepted for processing. The actual saving and publishing happens asynchronously.

#### Request Body
```typescript
{
  "productId": string;
  "variantId": string;
  "publishIntent": "SAVE_SSSYNC_DRAFT" | "PUBLISH_PLATFORM_DRAFT" | "PUBLISH_PLATFORM_LIVE"; // Determines if publishing jobs are queued
  "platformDetails": { // Contains the final, curated data for each specified platform.
                       // The backend will use this data to update the canonical record
                       // and as the source of truth when publishing to the respective platform.
    [platformSlug: string]: { // Platform-specific curated details (e.g., "shopify", "amazon")
      "title": string;
      "description": string; // Can be plain text or HTML, depending on platform
      "price": number;
      "sku"?: string;
      "barcode"?: string;
    "vendor"?: string;
    "productType"?: string;
      "tags"?: string[]; // Array of tags
      "status"?: "active" | "draft" | "archived"; // Platform-specific status
      "weight"?: number;
      "weightUnit"?: "lb" | "kg" | "oz" | "g"; // Or other platform-supported units
      // ... other common and platform-specific fields
      // For complex structures like multi-variant options, consult specific platform endpoint
      // documentation (e.g., /api/products/:id/publish/shopify) or how the backend
      // expects this generic structure to be mapped.
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
  "message": "SAVE_SSSYNC_DRAFT request received and processing started." 
  // or "PUBLISH_PLATFORM_DRAFT request received and processing started."
}
```
This endpoint updates the canonical `Product` and `ProductVariant` tables with the details provided primarily from the first key under `platformDetails` or a "canonical" key if present. If `publishIntent` is `PUBLISH_PLATFORM_DRAFT`, jobs are enqueued (e.g., via `QueueManager.enqueueJob({ type: 'product-publish', ... })`) to handle platform-specific API calls.

**Asynchronous Publishing & Initial Inventory:**
Publishing to external platforms (like Shopify) is an asynchronous process. This endpoint queues the task, and the actual creation/update on the platform happens in the background.

*   **For setting initial inventory precisely on Shopify (by location):**
    1.  After this `/api/products/publish` call returns `202 Accepted`, the product creation process on Shopify will begin.
    2.  Once the product is available on Shopify (this may take a few moments), retrieve the Shopify Location GIDs using `GET /api/products/shopify/locations`.
    3.  Then, make a call to `POST /api/products/:id/publish/shopify` (where `:id` is your canonical `productId`) providing the `platformConnectionId`, and the `locations` array with specific quantities for each `locationId`. This ensures accurate initial stock levels.

#### Example
```typescript
// Request to save draft and initiate publish to Shopify
const response = await fetch('/api/products/publish', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer <YOUR_SUPABASE_TOKEN>',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    productId: "prod_abc123",
    variantId: "var_def456",
    publishIntent: "SAVE_SSSYNC_DRAFT",
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
const data = await response.json(); // { "message": "SAVE_SSSYNC_DRAFT request received and processing started." }
```

### 4. Direct Product Creation (Manual)
Creates a new `Product` and `ProductVariant` directly with user-provided data, bypassing AI analysis and generation.

```http
POST /api/products
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
The response structure is similar to the `/api/products/analyze` endpoint, but the `analysis` field will typically be `null`.
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
const response = await fetch('/api/products', {
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
Directly creates or updates a product on Shopify. This is a more direct way to publish compared to the general `/api/products/publish` if Shopify is the explicit target, and is recommended for setting detailed initial inventory.

```http
POST /api/products/:id/publish/shopify
```
Where `:id` is the canonical **Product ID** from your system (e.g., obtained after creating/analyzing a product).

**Important Note on Product Content (Title, Description, etc.):**
This endpoint publishes the product identified by `:id` to Shopify. The core content of the product (like its title, main description, SKU, price, images) is taken from the **existing canonical `Product` and `ProductVariant` records stored in your database** associated with this `:id`.

Therefore, **before calling this endpoint, ensure that the canonical product has been fully defined and saved with all necessary details (especially `Title`)** using an endpoint like `POST /api/products/publish` or a direct creation endpoint.

The `options` field in the request body of *this* endpoint (`/api/products/:id/publish/shopify`) is for providing Shopify-specific overrides or settings for *this particular publishing act* (e.g., Shopify status, vendor for Shopify, tags for Shopify). It does not update the canonical product record itself.

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
const response = await fetch('/api/products/prod_abc123/publish/shopify', {
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
GET /api/products/shopify/locations?platformConnectionId=<platformConnectionId_value>
```

**Feature Flag:** `shopify`
**Rate Limit:** 10 requests per minute

#### Purpose
This endpoint is crucial for managing Shopify inventory accurately. It provides the necessary Shopify Location GIDs (e.g., `"gid://shopify/Location/12345"`). These GIDs are required when:
- Setting initial inventory quantities for specific locations when publishing a new product using the `POST /api/products/:id/publish/shopify` endpoint.
- Updating inventory levels for existing products at specific Shopify locations via API calls.
- Displaying location-based inventory information in your user interface.

#### Important Prerequisites - How to Get `platformConnectionId` and Ensure Validity:
Before calling this endpoint, you **must** first:

1.  **Fetch Platform Connections:**
    *   Call `GET /api/platform-connections` (this endpoint is documented separately, typically under a "Platform Connections API" section if available, or your backend engineer can provide its details).
    *   This will return an array of all connections for the authenticated user.
2.  **Identify and Verify the Shopify Connection:**
    *   From the array, find the desired Shopify connection (e.g., by `PlatformType: "shopify"`).
    *   Note its `Id` – this is the `platformConnectionId` required for this `/api/products/shopify/locations` endpoint.
    *   **Crucially, verify the connection's status:**
        *   The `IsEnabled` field for the connection **must be `true`**.
        *   The `Status` field should be one of the following "activatable" states:
            *   `'connected'`
            *   `'active'`
            *   `'needs_review'`
            *   `'syncing'`
            *   `'active_sync'`
            *   `'ready'`
    *   If `IsEnabled` is `false` or the `Status` is not one of the above (e.g., it's `'error'` or `'disconnected'`), do **not** proceed to call `/api/products/shopify/locations`. Instead, guide the user to check their connection settings or re-authenticate the Shopify connection.

Only after successfully obtaining a `platformConnectionId` for an **enabled** Shopify connection with a **valid status** should you proceed to call this endpoint.

#### Query Parameters
- `platformConnectionId` (required): string - The `Id` of the Shopify `PlatformConnection` obtained and verified as described in "Important Prerequisites".

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
const response = await fetch('/api/products/shopify/locations?platformConnectionId=conn_shopify_123', {
  method: 'GET',
  headers: { 'Authorization': 'Bearer <YOUR_SUPABASE_TOKEN>' }
});
const data = await response.json();
```

### 7. Get Shopify Inventory Levels
Fetches current inventory levels for products from a connected Shopify store. Can optionally trigger a fresh sync from Shopify before returning data.

```http
GET /api/products/shopify/inventory?platformConnectionId=<platformConnectionId_value>&sync=<true_or_false>
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
const response = await fetch('/api/products/shopify/inventory?platformConnectionId=conn_shopify_123', {
  method: 'GET',
  headers: { 'Authorization': 'Bearer <YOUR_SUPABASE_TOKEN>' }
});
const data = await response.json();

// Request (force sync then fetch inventory)
const responseSync = await fetch('/api/products/shopify/inventory?platformConnectionId=conn_shopify_123&sync=true', {
  method: 'GET',
  headers: { 'Authorization': 'Bearer <YOUR_SUPABASE_TOKEN>' }
});
const dataSync = await responseSync.json();
```

### 8. Get Shopify Locations with Products (Aggregated View)
Provides a convenient aggregated view of Shopify locations, each with a list of products and their inventory quantities at that specific location. Useful for UIs displaying inventory by location.

```http
GET /api/products/shopify/locations-with-products?platformConnectionId=<platformConnectionId_value>&sync=<true_or_false>
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
The `sync` behavior is identical to the `/api/products/shopify/inventory` endpoint.

#### Example
```typescript
// Request
const response = await fetch('/api/products/shopify/locations-with-products?platformConnectionId=conn_shopify_123&sync=false', {
  method: 'GET',
  headers: { 'Authorization': 'Bearer <YOUR_SUPABASE_TOKEN>' }
});
const data = await response.json();
```

### 9. Queue Product Sync Job (Example)
This is an example endpoint demonstrating how a product sync job could be queued using the dynamic queue manager. The actual implementation for triggering syncs for specific products or connections would depend on the evolving `SyncEngine` requirements.

```http
POST /api/products/queue-sync
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

## Trigger Periodic Reconciliation Sync

Manually triggers a periodic reconciliation sync for a specific platform connection. This process will:
    * Fetch all product identifiers from the connected platform.
    * Compare these with the canonical product data in sssync's database.
    * Identify and queue tasks to add any new products found on the platform.
    * Identify and queue tasks to handle products that are in sssync's DB but no longer on the platform.
    * Reconcile inventory levels for all mapped products, treating the platform as the source of truth.

This is useful for ensuring data consistency and picking up changes that might have been missed by real-time webhooks, or for an initial full data comparison after a connection is established or re-enabled. The job is queued, and processing happens asynchronously.

*   **Endpoint:** `POST /api/sync/connection/:connectionId/reconcile`
*   **Auth Required:** Yes (Supabase JWT)
*   **Permissions:** User must own the specified `connectionId`.
*   **Path Parameters:**
    *   `connectionId` (UUID): The ID of the platform connection to reconcile.
*   **Request Body:** None
*   **Success Response (202 Accepted):**
    ```json
    {
        "message": "Reconciliation job successfully queued for connection xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx. Job ID: <job_id>",
        "jobId": "<job_id>"
    }
    ```
*   **Error Responses:**
    *   `400 Bad Request`: If the connection is disabled or `connectionId` is not a valid UUID.
    *   `401 Unauthorized`: If authentication fails.
    *   `404 Not Found`: If the connection ID doesn't exist or doesn't belong to the user.
    *   `500 Internal Server Error`: If the connection is missing critical information like `PlatformType`.

**How to use:**

1.  Obtain a valid JWT for an authenticated user.
2.  Identify the `connectionId` (UUID) of the platform connection you wish to reconcile. This can be retrieved from the `GET /api/platform-connections` endpoint.
3.  Make a POST request to the endpoint, including the `Authorization` header with the Bearer token and the `connectionId` in the path.
4.  The API will respond with a 202 status code if the job is successfully queued, along with a message and the `jobId`.
5.  The actual reconciliation process happens in the background. You can monitor activity logs or check product/inventory data after some time to see the results.

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
    "message": "Cannot POST /api/products/analyze. Ensure the URL is correct and includes the /api prefix if applicable.",
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
- Endpoints like `POST /api/products/publish` might return a `202 Accepted` status, indicating the request has been queued for processing.
- The status of these background jobs can be tracked through other means (e.g., webhook notifications, polling a job status endpoint - TBD).
- For precise control over initial inventory settings on platforms like Shopify, it's often recommended to use platform-specific endpoints (e.g., `POST /api/products/:id/publish/shopify`) after the main publish request has been accepted and the product shell is created on the platform. Refer to the documentation for `/api/products/publish` and `/api/products/shopify/locations` for more details on this flow.


##How Reconcilation Works:


### Current Application Flow

The system is designed to keep your product inventory synchronized between your sssync backend and connected e-commerce platforms (like Shopify). Here's a breakdown:

1.  **Connecting a New Platform (e.g., Shopify):**
    *   You (the user) initiate an OAuth flow from your client application. For Shopify, this would involve linking to an endpoint like `GET /api/auth/shopify/login`.
    *   The backend (`AuthController`, `AuthService`) handles the OAuth dance with Shopify, obtains credentials (like an access token), encrypts them, and saves them in the `PlatformConnections` table in your Supabase database. The connection is typically marked as `IsEnabled: true` and might have an initial `Status` like `'connecting'`.
    *   The `AuthService` also uses JWTs for managing the `state` parameter during the OAuth flow to prevent CSRF attacks and pass necessary information like `userId` and the `finalRedirectUri`.

2.  **Initial Scan & Data Ingestion:**
    *   Once a platform is connected, an **`initial-scan` job** is typically queued. This job is processed by one of the queue workers (`InitialScanProcessor` or `ReconciliationProcessor` indirectly).
    *   The processor uses the appropriate platform **adapter** (e.g., `ShopifyAdapter`) and its **API client** (e.g., `ShopifyApiClient`) to fetch all existing products, variants, locations, and inventory levels from the newly connected platform. (e.g., `ShopifyApiClient.fetchAllRelevantData()`).
    *   The fetched platform-specific data is then transformed into your app's **canonical data model** by a **mapper** (e.g., `ShopifyMapper.mapShopifyDataToCanonical()`).
    *   **Mapping Suggestions:** The `MappingService` attempts to match these incoming platform products with any existing canonical products you might already have (e.g., from a previous CSV import or another platform connection). This involves comparing SKUs, barcodes, titles, etc.
    *   **User Confirmation:** You'll likely interact with a UI (not part of the backend itself) that presents these mapping suggestions. You confirm which platform products link to existing canonical products, which should create new canonical products, and which to ignore. This confirmation would call an endpoint like `POST /api/sync/connections/:connectionId/confirm-mappings`.
    *   `InitialSyncService.saveConfirmedMappings()` persists these choices, creating entries in `PlatformProductMappings`.
    *   Based on these mappings, new canonical products/variants are created in your Supabase DB (`Products`, `ProductVariants` tables via `ProductsService`), and initial inventory levels are stored (`InventoryLevels` table via `InventoryService`).

3.  **Ongoing Synchronization (Keeping Data Up-to-Date):**
    *   **Webhooks (Real-time):**
        *   Platforms like Shopify can send real-time notifications (webhooks) when events occur (e.g., a new product is created, inventory is updated).
        *   These webhooks hit your `/api/webhooks/:platform` endpoint.
        *   The `WebhookController` verifies and passes the payload to the `SyncCoordinatorService`.
        *   The `SyncCoordinatorService` uses the relevant adapter and mapper to update your canonical data (Products, InventoryLevels) immediately. It can also trigger updates to *other* linked platforms if a change originated from one specific platform.
    *   **Periodic Reconciliation Sync (Scheduled Background Job - Daily by default):**
        *   A scheduled task (`TasksService`) runs daily (e.g., at 3 AM).
        *   It fetches all `IsEnabled: true` platform connections (`PlatformConnectionsService.getAllEnabledConnections()`).
        *   For each connection, it queues a **`reconciliation` job** (`InitialSyncService.queueReconciliationJob()`).
        *   The `ReconciliationProcessor` handles these jobs:
            1.  It fetches a lightweight overview of all products currently on the platform (e.g., `ShopifyApiClient.fetchAllProductOverviews()`).
            2.  It compares this list against your `PlatformProductMappings` table.
            3.  **New Products:** If products exist on the platform but are not in your mappings, the processor fetches their full details (e.g., `ShopifyApiClient.fetchProductsByIds()`), maps them to canonical models, saves them to your `Products` and `ProductVariants` tables, stores their inventory in `InventoryLevels`, and creates new entries in `PlatformProductMappings`. This is how products added directly on Shopify (like your 7 new ones) would be automatically imported.
            4.  **Missing Products:** (Logic can be expanded) It identifies products that are in your mappings but no longer found on the platform. It might log this or mark the canonical product/mapping as needing review.
            5.  **Inventory Reconciliation:** For all products that *are* mapped, it fetches the current live inventory from the platform (e.g., `ShopifyApiClient.getInventoryLevels()`) and updates your canonical `InventoryLevels` table to match. This ensures quantities are accurate.
    *   **Manual Triggers / API Endpoints:**
        *   Your application's UI will primarily read product and inventory data from your **canonical Supabase tables**.
        *   The frontend can subscribe to real-time changes in these Supabase tables (e.g., `InventoryLevels`) for instant UI updates.
        *   Some API endpoints (e.g., `GET /api/products/shopify/inventory?sync=true`) might allow an optional `sync=true` parameter to force an immediate on-demand fetch from the platform, but this should be used sparingly to avoid rate limits.

4.  **Queue Management:**
    *   The `QueueManagerService` decides whether to use the `UltraLowQueueService` (a simple Redis list, good for most cases) or the `BullMQQueueService` (more robust, for high-load scenarios). The thresholds are set very high, so it will almost always use the `UltraLowQueueService`. This was done to reduce Redis load from BullMQ's more frequent polling.

### How to Test the Flow

Testing will involve interacting with your API, observing logs, and checking data in your Supabase database and potentially Redis.

**Prerequisites:**
*   Your NestJS application running.
*   `.env` file correctly configured (Supabase URL/keys, Redis URL, Shopify API key/secret/scopes/redirect URI, JWT secret, encryption secret).
*   A Shopify development store with some products.
*   A tool like Postman or `curl` for making API requests.
*   Access to your Supabase dashboard to inspect tables.

**Testing Steps:**

1.  **Connect Shopify:**
    *   **Action:** Use your client (or Postman redirecting in a browser) to hit `GET /api/auth/shopify/login?userId=<your_user_id>&shop=<your-shop-name>.myshopify.com&finalRedirectUri=<http://localhost:3000/some-client-callback-route>`.
    *   Complete the Shopify OAuth flow in your browser.
    *   **Verify:**
        *   You're redirected to your `finalRedirectUri` with `status=success`.
        *   A new entry appears in the `PlatformConnections` table for your user and Shopify, with `Status` likely 'connecting' or 'needs_review' and `IsEnabled: true`. Credentials should be encrypted.
        *   Check application logs for messages from `AuthService` and `PlatformConnectionsService`.

2.  **Initial Scan & Mapping:**
    *   **Action (Automatic):** After connection, an `initial-scan` job should be queued.
    *   **Verify (Logs & Queues):**
        *   Check logs for `InitialScanProcessor` activity (or whichever processor is configured for `initial-scan` jobs via `bullmq-high-queue` or `ultra-low-queue`).
        *   The processor should log fetching data from Shopify (`ShopifyApiClient.fetchAllRelevantData`).
    *   **Action (API):** Once the scan is logged as complete, fetch mapping suggestions:
        `GET http://localhost:3000/api/sync/connections/<your_connection_id>/mapping-suggestions` (Include your JWT Auth Bearer token).
    *   **Verify (API Response):** You should get a list of platform products and any suggested canonical matches.
    *   **Action (API):** Confirm the mappings:
        `POST http://localhost:3000/api/sync/connections/<your_connection_id>/confirm-mappings` (Auth token needed) with a body like:
        ```json
        {
          "confirmedMatches": [
            { "platformProductId": "gid://shopify/Product/123", "sssyncVariantId": null, "action": "create" },
            { "platformProductId": "gid://shopify/Product/456", "sssyncVariantId": "your-existing-canonical-variant-uuid", "action": "link" }
          ]
        }
        ```
    *   **Verify (Database):**
        *   New entries in `PlatformProductMappings`.
        *   New entries in `Products` and `ProductVariants` for `action: "create"`.
        *   Inventory levels populated in `InventoryLevels`.
        *   The `PlatformConnections` status might update to `syncing` or `connected`.

3.  **Periodic Reconciliation Sync:**
    *   **Action (Add data on Shopify):**
        1.  Log into your Shopify development store.
        2.  Add 1-2 new products *directly in Shopify*.
        3.  Change the inventory quantity of an existing product that is already synced/mapped.
    *   **Action (Trigger Reconciliation):**
        *   **Option A (Wait):** The `TasksService` cron job runs daily.
        *   **Option B (Manual Trigger via API):** Call `POST /api/sync/connections/<your_connection_id>/trigger-reconciliation` (Auth token needed). This will queue a reconciliation job.
    *   **Verify (Logs & Database):**
        *   Monitor logs for `ReconciliationProcessor` activity for your connection.
        *   Look for logs indicating it's fetching product overviews, comparing, and then fetching full details for new products.
        *   Check your Supabase tables:
            *   The new products you added on Shopify should now appear in your `Products` and `ProductVariants` tables.
            *   New entries for these products should be in `PlatformProductMappings`.
            *   The `InventoryLevels` for the product whose quantity you changed on Shopify should now reflect the new Shopify quantity in your database.
            *   The `LastSyncSuccessAt` timestamp on the `PlatformConnections` entry should update.

4.  **Webhooks (Advanced Test):**
    *   This requires a publicly accessible URL for your dev machine (e.g., using ngrok).
    *   **Action:**
        1.  Start ngrok: `ngrok http 3000`. Note the public URL (e.g., `https://<random_string>.ngrok.io`).
        2.  In your Shopify store admin, go to Settings -> Notifications -> Webhooks.
        3.  Create webhooks for events like `Product creation`, `Product update`, `Inventory level update`. Set the URL to `https://<random_string>.ngrok.io/api/webhooks/shopify`.
        4.  Now, perform actions in Shopify (create a product, update inventory).
    *   **Verify (Logs & Database):**
        *   Your NestJS logs should show requests hitting `/api/webhooks/shopify`.
        *   `WebhookController` and `SyncCoordinatorService` logs should indicate processing.
        *   Changes should reflect (almost) instantly in your Supabase tables.

5.  **API Endpoints for Data Retrieval:**
    *   **Action:** Call endpoints like `GET /api/products/shopify/inventory?platformConnectionId=<your_connection_id>` (Auth token).
    *   **Verify:** The data returned should match what's in your canonical Supabase tables.

### Endpoint to List Connections

You asked about how to use the `fetchConnections` endpoint. The correct endpoint to list your platform connections is:

*   **Method:** `GET`
*   **Path:** `/api/platform-connections`
*   **Controller:** `PlatformConnectionsController`
*   **Method:** `listConnections(@Request() req)`
*   **Service Method:** `PlatformConnectionsService.getConnectionsForUser(userId)`

**Authentication:** This endpoint is protected by `SupabaseAuthGuard`, so you need to include a valid JWT Bearer token in the `Authorization` header of your request. This token is what `req.user.id` is derived from.

**What it Returns:**
The service method `getConnectionsForUser` is designed to return only non-sensitive fields. It explicitly selects:
`Id, UserId, PlatformType, DisplayName, Status, IsEnabled, LastSyncSuccessAt, CreatedAt, UpdatedAt`

It **does not** return the encrypted `Credentials` or the full `PlatformSpecificData` (though `PlatformSpecificData` might contain some safe summary info if it were added there, but typically it holds things like `shop` domain or `merchantId` which are fine).

**How to Call It (Example using `curl`):**
Assuming you have a valid Supabase JWT for a user:

```bash
curl -X GET \
  http://localhost:3000/api/platform-connections \
  -H "Authorization: Bearer <YOUR_SUPABASE_JWT_TOKEN>" \
  -H "Content-Type: application/json"
```

**Example Response:**
You would receive a JSON array of connection objects, like this:

```json
[
  {
    "Id": "a1b2c3d4-e5f6-7890-1234-567890abcdef",
    "UserId": "user-uuid-from-jwt",
    "PlatformType": "shopify",
    "DisplayName": "my-awesome-store.myshopify.com",
    "Status": "connected",
    "IsEnabled": true,
    "LastSyncSuccessAt": "2023-11-15T10:30:00.000Z",
    "CreatedAt": "2023-11-10T09:00:00.000Z",
    "UpdatedAt": "2023-11-15T10:30:05.000Z"
  },
  {
    "Id": "x1y2z3w4-v5u6-7890-aabb-ccddeeff0011",
    "UserId": "user-uuid-from-jwt",
    "PlatformType": "clover",
    "DisplayName": "Clover (XYZMerchant)",
    "Status": "needs_review",
    "IsEnabled": true,
    "LastSyncSuccessAt": null,
    "CreatedAt": "2023-11-12T14:00:00.000Z",
    "UpdatedAt": "2023-11-12T14:05:00.000Z"
  }
  // ... more connections for this user
]
```

This detailed explanation should give you a good overview and a solid plan for testing. Let me know if any part is unclear!



Okay, this is an excellent and comprehensive request. Let's break this down into actionable parts.

**1. Comprehensive Testing Plan (Shopify, Clover, Square)**

We'll test the end-to-end flow for each platform. The core steps will be similar, with platform-specific API calls and data structures being handled by their respective adapters.

**I. Prerequisites for All Platforms:**

*   **Environment Setup:**
    *   Your NestJS application is running locally.
    *   Your `.env` file is fully configured: Supabase (URL, Anon Key, Service Role Key), Redis (URL), JWT Secret, Credentials Encryption Secret.
    *   Platform API Keys & Secrets:
        *   Shopify: API Key, API Secret, Scopes, Redirect URI.
        *   Clover: App ID, App Secret, Redirect URI (for both Sandbox and Production, though we'll primarily test with Sandbox).
        *   Square: Application ID, Application Secret, Redirect URI, Scopes (for both Sandbox and Production, primarily testing with Sandbox).
    *   You have active sandbox/developer accounts:
        *   Shopify Development Store.
        *   Clover Sandbox Merchant Account.
        *   Square Sandbox Account.
    *   **Initial Data:** Populate each platform's sandbox with 5-7 distinct products.
        *   Include a mix: some simple products, some with 2-3 variants (e.g., Size: S/M/L, Color: Red/Blue).
        *   Ensure some products/variants have SKUs.
        *   Ensure some products/variants have unique barcodes.
        *   Set varying inventory levels for products/variants, across different locations if the platform supports it explicitly in the sandbox (Shopify does, Square can, Clover is often merchant-level).
*   **Tools:**
    *   API Client (Postman, Insomnia, or `curl`) for making HTTP requests.
    *   Supabase Dashboard access to inspect tables: `Users`, `PlatformConnections`, `Products`, `ProductVariants`, `PlatformProductMappings`, `InventoryLevels`, `ActivityLogs`.
    *   Application logs (NestJS console output).

**II. Test Flow (Repeat for Shopify, then Clover, then Square):**

**Phase 1: OAuth Connection & Initial Setup**

1.  **Authenticate a User & Obtain JWT:**
    *   Ensure you have a user in your Supabase `Users` table. If not, create one (e.g., via Supabase Studio or a signup flow if you have one).
    *   Obtain a JWT for this user (e.g., by "logging in" through a test script or Supabase's SQL editor to generate a token for a test user).
2.  **Initiate OAuth Connection:**
    *   **Action:** Using your API client (ensure it can handle redirects or you can manually follow them in a browser), construct and hit the appropriate login URL. Replace `<YOUR_USER_ID>` and `<YOUR_JWT_TOKEN>`.
        *   **Shopify:**
            `GET {{base_url}}/auth/shopify/login?userId=<YOUR_USER_ID>&shop=<your-dev-shop-name>.myshopify.com&finalRedirectUri=http://localhost:8000/auth-callback-test` (Replace `{{base_url}}` with your app's local URL, e.g., `http://localhost:3000/api`)
        *   **Clover (Sandbox):**
            `GET {{base_url}}/auth/clover/login?userId=<YOUR_USER_ID>&finalRedirectUri=http://localhost:8000/auth-callback-test`
            *(Ensure `CLOVER_API_BASE_URL` in your `.env` points to the Clover Sandbox: `https://sandbox.dev.clover.com`)*
        *   **Square (Sandbox):**
            `GET {{base_url}}/auth/square/login?userId=<YOUR_USER_ID>&finalRedirectUri=http://localhost:8000/auth-callback-test`
            *(Ensure `SQUARE_API_BASE` in your `.env` points to Square Sandbox: `https://connect.squareupsandbox.com`)*
    *   Complete the authentication flow on the respective platform's website.
    *   **Verify:**
        *   Successful redirection to your `finalRedirectUri` with query parameters like `connection=<platform>&status=success`.
        *   **Supabase `PlatformConnections` Table:**
            *   A new row exists for the user and the connected platform.
            *   `IsEnabled` is `true`.
            *   `Credentials` are present (and should be encrypted, though you can't directly see the decrypted value).
            *   `PlatformSpecificData` contains relevant IDs (e.g., `shop` for Shopify; `merchantId` for Clover and Square).
            *   `Status` is appropriate (e.g., `connected`, `needs_review`).
        *   **Application Logs:** Check for successful token exchange messages from `AuthService` and `PlatformConnectionsService`.
        *   **Supabase `ActivityLogs` Table:** Entry for "AUTH_SUCCESS" or similar for the platform connection.

3.  **List Platform Connections:**
    *   **Action:** `GET {{base_url}}/platform-connections` (Header: `Authorization: Bearer <YOUR_JWT_TOKEN>`).
    *   **Verify:**
        *   The newly connected platform is listed in the JSON array response.
        *   The response includes `Id`, `PlatformType`, `DisplayName`, `Status`, `IsEnabled`.
        *   Crucially, the encrypted `Credentials` are NOT present in this API response.

**Phase 2: Initial Scan, Data Ingestion & Mapping**
*The system should automatically queue an `initial-scan` job after a successful connection.*

1.  **Monitor Initial Scan:**
    *   **Verify (Application Logs & Queue [if accessible]):**
        *   Logs from `InitialScanProcessor` (or `ReconciliationProcessor` if it handles this queue) indicating a job for the new connection.
        *   Logs from the relevant platform adapter (`ShopifyAdapter`, `CloverAdapter`, `SquareAdapter`) and its API client showing it's fetching data (`fetchAllRelevantData`).
            *   Shopify: Calls to fetch products, locations.
            *   Clover: Calls to fetch items, merchant details.
            *   Square: Calls to fetch catalog objects, inventory, locations.
        *   Logs from `MappingService` trying to `generateSuggestions`.
        *   `PlatformConnections.Status` in Supabase might transition (e.g., `scanning` -> `needs_review`).
        *   `ActivityLogs` entry for scan start/completion, potentially with counts of items found.

2.  **Fetch Mapping Suggestions:**
    *   **Action:** `GET {{base_url}}/sync/connections/<platform_connection_id>/mapping-suggestions` (Header: `Authorization: Bearer <YOUR_JWT_TOKEN>`). Use the `Id` from the `PlatformConnections` table.
    *   **Verify:**
        *   Response is a JSON array. Each item represents a product/variant from the platform.
        *   For a fresh setup, `suggestedCanonicalVariant` should likely be `null` for all, and `matchType` should be `NONE`.

3.  **Confirm Mappings (Instructing to Create New Canonical Products):**
    *   **Action:** `POST {{base_url}}/sync/connections/<platform_connection_id>/confirm-mappings` (Header: `Authorization: Bearer <YOUR_JWT_TOKEN>`).
    *   Construct the body based on the response from "Fetch Mapping Suggestions". For all products, set `action: "create"` and `sssyncVariantId: null`.
        ```json
        {
          "confirmedMatches": [
            // Example for one platform product:
            {
              "platformProductId": "<platform_product_id_from_suggestions>",
              "platformVariantId": "<platform_variant_id_from_suggestions_if_any>", // May be null if product is simple
              "platformProductSku": "<sku_from_suggestions_if_any>",
              "platformProductTitle": "<title_from_suggestions>",
              "sssyncVariantId": null,
              "action": "create"
            }
            // ... more entries for all products from the platform
          ]
        }
        ```
    *   **Verify:**
        *   **Supabase `Products` Table:** New entries created for each unique product concept from the platform.
        *   **Supabase `ProductVariants` Table:** New entries for each product/variant. Check for correct `ProductId`, `Sku`, `Title`, `Price`, `Barcode`, etc.
        *   **Supabase `PlatformProductMappings` Table:** New entries linking platform IDs (product & variant) to the newly created canonical `ProductVariantId`. Check `PlatformProductId`, `PlatformVariantId`, `PlatformSku`.
        *   **Supabase `InventoryLevels` Table:** Entries populated for each mapped variant, reflecting stock quantities and location IDs from the platform.
        *   **Application Logs:** Messages from `InitialSyncService.saveConfirmedMappings`, `ProductsService`, `InventoryService`, `PlatformProductMappingsService` showing data creation.
        *   **`ActivityLogs`:** Entries for mapping confirmation, product creation, inventory ingestion.
        *   **`PlatformConnections.Status`:** Should update (e.g., to `syncing`, then `connected` or `active_sync`).

**Phase 3: Reconciliation Sync (The Core Test)**

1.  **Introduce Changes on the Platform:**
    *   **Action (Directly in Shopify/Clover/Square Admin Panel):**
        1.  **Add New Products:** Create 1-2 entirely new products on the platform that don't exist in sssync.
        2.  **Update Inventory:** For 1-2 *already mapped/synced* products, change their inventory quantity (e.g., increase stock of one, decrease another).
        3.  **(Optional) Update Product Details:** For 1 mapped product, change its title or price on the platform.
        4.  **(Optional) Delete Product:** Delete 1 mapped product from the platform.
    *   *Wait a few minutes for platform changes to settle.*

2.  **Trigger Reconciliation Sync:**
    *   **Action:** `POST {{base_url}}/sync/connection/<platform_connection_id>/reconcile` (Header: `Authorization: Bearer <YOUR_JWT_TOKEN>`).
    *   **Verify (Logs & Queues):**
        *   Application logs show `InitialSyncService.queueReconciliationJob` being called.
        *   `ReconciliationProcessor` logs show it picking up the job.
        *   Adapter logs:
            *   Fetching product overviews (e.g., `ShopifyApiClient.fetchAllProductOverviews`).
            *   Comparing platform list with `PlatformProductMappings`.
            *   For **new products**: fetching full details (e.g., `ShopifyAdapter.fetchProductsByIds`).
            *   For **existing mapped products**: fetching current live inventory (e.g., `ShopifyApiClient.getInventoryLevels`).

3.  **Verify Reconciliation Results (Crucial Step):**
    *   **Wait for the job to complete (monitor logs).**
    *   **Verify (Supabase Tables & Logs):**
        *   **Newly Added Products:**
            *   The products you added directly on the platform should now exist in your `Products` and `ProductVariants` tables.
            *   New `PlatformProductMappings` should be created for them.
            *   `InventoryLevels` for these new products should accurately reflect their initial stock from the platform.
            *   `ActivityLogs` should show "NEW_PRODUCT_FOUND_FROM_PLATFORM" or similar.
        *   **Inventory Quantity Changes:**
            *   The `InventoryLevels` table entries for the products whose quantities you changed on the platform should now reflect these **new platform quantities**. This is key – reconciliation treats the platform as the source of truth for inventory.
            *   `ActivityLogs` for "INVENTORY_LEVEL_RECONCILED".
        *   **(Optional) Product Detail Changes (Title/Price):**
            *   Check the `ProductVariants` table. Did the title/price of the product you edited on the platform update in your canonical database? *Current reconciliation primarily focuses on new products and inventory. Updating existing canonical details from platform changes might be a future enhancement or a configurable behavior (platform-is-truth vs. sssync-is-truth for specific fields).*
        *   **(Optional) Deleted Products:**
            *   How did the system handle the product deleted from the platform?
                *   Is the `PlatformProductMapping` marked as `IsEnabled: false` or `SyncStatus: 'PlatformProductNotFound'`?
                *   Is the canonical `Product` or `ProductVariant` archived or deleted? (Typically, canonical data might be preserved but marked, rather than hard deleted, to avoid data loss if it was an accidental platform deletion).
            *   Check `ActivityLogs`.
        *   **`PlatformConnections.LastSyncSuccessAt`:** This timestamp should be updated.

**Phase 4: API Data Pulling & Verification**

1.  **Fetch Inventory via API (Example for Shopify; adapt for other platforms if equivalent direct-inventory-pull endpoints are added):**
    *   **Action (Shopify):**
        *   `GET {{base_url}}/products/shopify/inventory?platformConnectionId=<shopify_connection_id>&sync=false` (Bearer token)
        *   `GET {{base_url}}/products/shopify/inventory?platformConnectionId=<shopify_connection_id>&sync=true` (Bearer token)
    *   **Verify (Shopify):**
        *   **`sync=false`:** The API should return inventory data based on the current state of your `InventoryLevels` table (which should be fresh after the reconciliation).
        *   **`sync=true`:**
            *   Logs show the `ShopifyAdapter` making live calls to Shopify for inventory.
            *   Your local `InventoryLevels` table should get updated again if there were any discrepancies.
            *   The API response should reflect the absolute latest inventory from Shopify.
            *   `PlatformConnections.LastSyncSuccessAt` should update.
        *   Cross-reference the API response quantities with what you see in the Shopify admin panel and your Supabase `InventoryLevels` table.

2.  **Fetch Shopify Locations (Shopify-specific):**
    *   **Action:** `GET {{base_url}}/products/shopify/locations?platformConnectionId=<shopify_connection_id>` (Bearer token).
    *   **Verify:** Response lists all locations from your Shopify dev store, each with a Shopify GID.

3.  **Fetch Shopify Locations with Products (Shopify-specific):**
    *   **Action:** `GET {{base_url}}/products/shopify/locations-with-products?platformConnectionId=<shopify_connection_id>&sync=false` (Bearer token).
    *   **Verify:**
        *   The response structure aggregates products under their respective locations.
        *   Inventory quantities shown should match the latest data in `InventoryLevels`.

**Phase 5: Product Updates (Canonical to Platform - Testing the Infrastructure)**

*Since the adapter methods `createProduct`, `updateProduct`, `deleteProduct`, `updateInventoryLevels` are mostly placeholders, full end-to-end testing of pushing changes *from* sssync *to* platforms isn't feasible yet. However, we can test that the `SyncCoordinatorService` correctly identifies the need to push and attempts to call the adapter methods.*

1.  **Manually Create/Update a Canonical Product (if you have internal admin tools or test scripts):**
    *   **Action:**
        *   Create a new `Product` and `ProductVariant` directly in your Supabase tables (mimicking an internal creation).
        *   OR, update the `Price` or `Title` of an *existing* canonical `ProductVariant` that is already mapped to platform products.
    *   **Triggering the Push (Conceptual):**
        *   Currently, there isn't a direct API endpoint to say "push this canonical product change to all platforms." This logic is typically triggered internally after a canonical entity is saved (e.g., via a database trigger, or an event emitted by `ProductsService.saveVariants` that `SyncCoordinatorService` listens to - this eventing part might not be fully implemented yet).
        *   For testing, you might need to:
            *   Manually invoke `SyncCoordinatorService.handleCanonicalProductCreation(newProductId, userId)` or `SyncCoordinatorService.handleCanonicalProductUpdate(updatedVariantId, userId)` if your test setup allows.
            *   Or, if `ProductsService` emits events, ensure `SyncCoordinatorService` is listening and reacts.
    *   **Verify (Application Logs):**
        *   `SyncCoordinatorService` logs should show it detecting the canonical change.
        *   It should iterate through all `IsEnabled: true` `PlatformConnections` for that user.
        *   For each connection, it should:
            *   Get the correct adapter (e.g., `ShopifyAdapter`).
            *   Attempt to call the relevant method (e.g., `adapter.createProduct(...)` or `adapter.updateProduct(...)`).
            *   Since these are placeholders, you should see logs like "createProduct not implemented for Shopify" or the error being thrown.
        *   This verifies the coordinator's logic up to the point of adapter invocation.

**2. Updating `products.md`**

I will review your `docs/api/products.md` and integrate the following:

*   **Refine "How Reconciliation Works":**
    *   Generalize the description to apply to Shopify, Clover, and Square.
    *   Emphasize that during reconciliation, the connected e-commerce platform is treated as the primary source of truth for inventory counts and for discovering new products.
    *   Clarify how products deleted on the platform are handled (e.g., mapping disabled, canonical product archived/flagged).
    *   Mention that updates to existing product *details* (like title, price) on the platform might not automatically overwrite canonical data unless specifically configured (as this can be a two-way sync dilemma).
*   **Add "Testing the Full Sync Flow" Section:**
    *   Summarize the phases from the testing plan above (OAuth, Initial Scan & Mapping, Reconciliation, API Data Pulling).
    *   Provide brief, actionable steps for a user/tester to follow.
    *   Link to relevant API endpoints within the document (e.g., "To check connection status, see GET /api/platform-connections... To trigger reconciliation, use POST /api/sync/connection/:connectionId/reconcile...").
*   **Add "Core Data Flows" Overview:**
    *   **Platform to sssync (Pull/Ingestion):**
        *   OAuth Connection -> Initial Scan (all products/inventory) -> Mapping -> Canonical Data Storage.
        *   Ongoing: Reconciliation Jobs (detects new platform products, updates all inventory from platform).
        *   Ongoing: Webhooks (real-time updates from platform for individual changes).
    *   **sssync to Platform (Push - *Conceptual for now, as implementation is partial*):**
        *   Canonical data created/updated in sssync (e.g., via UI, API, or another sync).
        *   `SyncCoordinatorService` detects change.
        *   Relevant adapter's `create/update/deleteProduct` or `updateInventoryLevels` method is called to push to specific platform.
*   **Ensure API endpoint documentation is consistent with the testing plan and current implementation.**

**3. System Robustness Assessment & Improvements**

**Current Strengths:**

*   **Modular Design:** The adapter pattern (`BaseAdapter`, specific implementations for Shopify, Clover, Square) is excellent for extensibility.
*   **Canonical Data Model:** Having a central `Products`, `ProductVariants`, `InventoryLevels` schema is crucial for multi-platform sync.
*   **OAuth Handled:** Secure authentication flows for all three major platforms are in place.
*   **Background Processing:** Use of queues (`UltraLowQueueService`, BullMQ a_option_) for tasks like initial scan and reconciliation is good for responsiveness.
*   **Basic Reconciliation:** The daily reconciliation job provides a safety net for data consistency, especially for inventory and new product discovery from platforms.
*   **API Documentation Started:** `products.md` is a good foundation.

**Areas for Immediate & Future Improvement:**

*   **Error Handling & Resilience:**
    *   **Granular Retries:** Implement more sophisticated retry logic within API clients (e.g., exponential backoff for 429s, specific error code handling).
    *   **Dead-Letter Queues (DLQ):** For queue jobs that consistently fail, move them to a DLQ for manual inspection instead of endless retries.
    *   **User Feedback on Errors:** Surface sync errors to the user (e.g., in `PlatformConnections.Status` or an `ActivityLog` that a UI can display). "Connection error, please re-authenticate Clover."
*   **Transactional Integrity:**
    *   For operations involving multiple database writes (e.g., creating Product + Variants + Mapping + Inventory), ensure these are wrapped in database transactions to prevent partial data states if one part fails. Supabase supports this.
*   **Outbound Rate Limiting:**
    *   Adapters calling platform APIs should respect those platforms' rate limits. Implement client-side rate limiters/throttlers in `ShopifyApiClient`, `CloverApiClient`, etc.
*   **Idempotency:**
    *   Ensure all create/update operations (both from platform-to-sssync and sssync-to-platform) are idempotent. This is vital for handling webhook retries or re-running failed jobs. (e.g., using platform IDs or unique transaction keys).
*   **Scalability of Reconciliation:**
    *   For users with very large catalogs (tens of thousands of products), fetching all product overviews daily can be resource-intensive.
    *   Explore if platforms offer delta APIs (e.g., "products updated since timestamp/cursor") to make reconciliation more efficient. If not, the current overview approach is the standard.
*   **Conflict Resolution (Push to Platform):**
    *   This is a major area for when you fully implement sssync-to-platform pushes.
    *   If sssync tries to update a product on Shopify, but that product was also just changed on Shopify directly, how is the conflict resolved?
        *   Strategies: Last-write-wins (based on timestamps), sssync-is-truth, platform-is-truth, or flag for manual user resolution. This needs to be configurable or clearly defined.
*   **Data Validation & Transformation:**
    *   More rigorous validation of data from platform APIs before mapping and saving. What if a price comes as a string instead of a number?
    *   Handle edge cases in mappers (e.g., unexpected nulls, malformed data).
*   **Configuration Management:**
    *   Centralize platform-specific settings (e.g., API versions to use, specific feature flags or behaviors per platform) rather than scattering them.
*   **Logging and Monitoring:**
    *   Implement more structured logging (e.g., consistent JSON format).
    *   Add correlation IDs to trace a request/job through multiple services.
    *   Integrate with a monitoring/alerting system for critical errors or queue backups.
*   **User Control & Visibility:**
    *   (Future UI) Dashboard showing connection status, last sync times, count of synced products.
    *   Log of sync activities and errors per connection.
    *   Ability to manually trigger a sync/reconciliation for a specific connection.
    *   Ability to pause/resume syncing for a connection.
*   **Automated Testing:**
    *   Expand unit tests for services, mappers, API clients.
    *   Develop integration tests for key flows (e.g., a full reconciliation loop for a mock platform).
*   **Two-Way Sync Strategy Definition:**
    *   Clearly define which system (sssync or the external platform) is the source of truth for different data fields (e.g., inventory might always come from platform during reconciliation, but title/description might be pushed from sssync). This can be complex and may need to be configurable per user or per field.
*   **Backup and Restore Strategy (Leading to your Google Docs idea):**
    *   **Database Backups:** Supabase provides automated backups. Understand their frequency and retention.
    *   **Application-Level "Snapshots":**
        *   Before major sync operations (like the first big push to a new platform), or periodically, consider a mechanism to snapshot key canonical data (e.g., export product/variant/inventory data to JSON/CSV files stored securely, perhaps in S3 or similar). This is your "application-level" backup.
        *   This could be extended to allow users to download their canonical data.
    *   **Versioning:** For critical canonical data, consider implementing version history in your tables (e.g., using audit triggers or a separate history table). This allows rollback of specific changes.
    *   **"Google Docs" Style Versioning/Restore (More Advanced):** This implies a much finer-grained history and diffing capability, possibly storing changes as events (Event Sourcing pattern). This is a significant architectural step but offers powerful audit and rollback. For a simpler start, periodic snapshots are more achievable.

This is a lot, but it provides a roadmap. The immediate next step is to execute the testing plan.

I'll now proceed to update `docs/api/products.md` based on this discussion. After that, we can refine the "Robustness & Improvements" section if you wish.



It seems the request to edit `docs/api/products.md` didn't result in any changes. This can happen if the model determines the existing content largely aligns with the instructions or if the instructions are too broad for an automated pass.

Let's try a more targeted approach to update `products.md`. I'll focus on specific sections first.

**Instruction for `products.md` update:**

1.  **Create a new top-level section: `# Core Data Synchronization Flows`**.
    *   Under this, create two sub-sections:
        *   `## Platform to sssync (Pull/Ingestion Flow)`
        *   `## sssync to Platform (Push Flow - Conceptual)`
2.  **Populate `## Platform to sssync (Pull/Ingestion Flow)` with:**
    *   A brief overview of how data comes from connected platforms into sssync.
    *   Steps:
        1.  **OAuth Connection Establishment:** User authorizes sssync, credentials stored.
        2.  **Initial Scan & Data Ingestion:** (Triggered post-connection)
            *   Platform adapter fetches all products, variants, locations, inventory.
            *   Mapper transforms data to canonical models.
            *   `MappingService` suggests links or new creations.
        3.  **User Confirms Mappings:** (Via an external UI) User decisions are sent to an endpoint like `POST /api/sync/connections/:connectionId/confirm-mappings`.
        4.  **Canonical Data Creation:** New `Products`, `ProductVariants`, `PlatformProductMappings`, and `InventoryLevels` are stored.
        5.  **Ongoing - Reconciliation (Periodic Background Job):**
            *   `TasksService` queues daily jobs.
            *   `ReconciliationProcessor` uses platform adapter to:
                *   Fetch lightweight product overviews from the platform.
                *   Compare with `PlatformProductMappings`.
                *   **Discover New Products:** If platform products are missing in mappings, fetch full details, map, create canonical entries and mappings.
                *   **Reconcile Inventory:** For all mapped products, fetch live inventory from the platform and update canonical `InventoryLevels`. The platform is the source of truth for inventory during reconciliation.
                *   **Handle Deleted Platform Products:** (Describe strategy: e.g., disable mapping, archive canonical product, log event).
        6.  **Ongoing - Webhooks (Real-time, if configured):**
            *   Platform sends event (e.g., product update, inventory change).
            *   `WebhookController` -> `SyncCoordinatorService` -> Adapter/Mapper -> Canonical data updated.
3.  **Populate `## sssync to Platform (Push Flow - Conceptual)` with:**
    *   A brief overview of how changes in sssync would propagate to connected platforms. *Clearly state this is largely conceptual for full implementation but the infrastructure is being built.*
    *   Steps:
        1.  **Canonical Data Change:** Product/variant/inventory created or updated in sssync's database (e.g., via admin UI, API, or sync from another platform).
        2.  **Change Detection:** `SyncCoordinatorService` is notified or detects this change.
        3.  **Adapter Invocation:** `SyncCoordinatorService` iterates through relevant, enabled `PlatformConnections`.
        4.  For each, it gets the appropriate adapter and calls methods like `createProduct`, `updateProduct`, `deleteProduct`, or `updateInventoryLevels` (currently placeholders) with the canonical data.
        5.  **Platform Update:** The adapter (once fully implemented) would make API calls to the platform to reflect the changes.

# Core Data Synchronization Flows

This section outlines the primary ways data moves between your connected e-commerce platforms and the sssync system.

## Platform to sssync (Pull/Ingestion Flow)

This flow describes how product and inventory data is pulled from your connected platforms (like Shopify, Clover, Square) and stored into sssync's canonical database.

1.  **OAuth Connection Establishment:**
    *   The user initiates an OAuth flow (e.g., via `GET /api/auth/shopify/login`) to grant sssync access to their platform account.
    *   The backend (`AuthService`) securely handles the OAuth exchange, obtains necessary credentials (access tokens), encrypts them, and stores them in the `PlatformConnections` table.

2.  **Initial Scan & Data Ingestion (Post-Connection):**
    *   Typically, after a new connection is successfully established and enabled, an `initial-scan` job is queued.
    *   The relevant queue processor (e.g., `InitialScanProcessor`) picks up this job.
    *   It uses the platform-specific **Adapter** (e.g., `ShopifyAdapter`, `CloverAdapter`, `SquareAdapter`) and its associated **API Client** to fetch all existing products, variants, locations (if applicable), and inventory levels from the platform.
    *   The platform-specific data is then transformed into sssync's canonical data models by the platform's **Mapper** (e.g., `ShopifyMapper.mapShopifyDataToCanonical()`).
    *   The `MappingService` then attempts to generate suggestions by comparing incoming platform products/variants with any existing canonical data in sssync (e.g., by matching SKUs or barcodes).

3.  **User Confirms Mappings (via an External UI/Application):**
    *   The user reviews the mapping suggestions provided by sssync.
    *   They confirm which platform products should link to existing canonical products, which should create new canonical products, and which (if any) should be ignored.
    *   These confirmed decisions are submitted to an endpoint like `POST /api/sync/connections/:connectionId/confirm-mappings`.

4.  **Canonical Data Creation & Storage:**
    *   The `InitialSyncService` (or a similar service handling confirmed mappings) processes these confirmations.
    *   New canonical `Products` and `ProductVariants` are created in the Supabase database via `ProductsService`.
    *   Links between the platform's product/variant identifiers and sssync's canonical `ProductVariantId` are stored in the `PlatformProductMappings` table via `PlatformProductMappingsService`.
    *   Initial inventory levels are recorded in the `InventoryLevels` table via `InventoryService`, associated with the correct canonical variant, platform connection, and platform location ID.

5.  **Ongoing - Reconciliation (Periodic Background Job - e.g., Daily):**
    *   A scheduled task (managed by `TasksService`) queues `reconciliation` jobs for all active and enabled platform connections.
    *   The `ReconciliationProcessor` handles these jobs:
        *   It instructs the platform adapter to fetch a lightweight overview of all products currently on the platform (e.g., IDs, SKUs, last update times).
        *   This list is compared against sssync's `PlatformProductMappings` for that connection.
        *   **Discover New Products:** If products exist on the platform but are not found in sssync's mappings, the processor directs the adapter to fetch their full details. This data is then mapped to canonical models, and new `Products`, `ProductVariants`, `PlatformProductMappings`, and `InventoryLevels` are created in sssync.
        *   **Reconcile Inventory:** For all existing mapped products, the processor directs the adapter to fetch the current live inventory quantities from the platform. These quantities then update the corresponding records in sssync's `InventoryLevels` table. **During reconciliation, the connected e-commerce platform is treated as the primary source of truth for inventory counts.**
        *   **Handle Deleted Platform Products:** If a product previously mapped in sssync is no longer found on the platform, the system will typically:
            *   Mark the corresponding `PlatformProductMapping` as `IsEnabled: false` or update its `SyncStatus` to indicate the platform product is missing.
            *   Potentially archive the canonical `Product` (set `IsArchived: true`) if no other active platform mappings exist for it.
            *   Log an event in `ActivityLogs` for user visibility. (The canonical product is usually not hard-deleted to prevent data loss from accidental platform deletions).

6.  **Ongoing - Webhooks (Real-time Updates, if configured by the user/system):**
    *   Platforms like Shopify can send real-time notifications (webhooks) when specific events occur (e.g., a new product is created, inventory is updated, an order is placed).
    *   These webhooks would be directed to an sssync endpoint like `/api/webhooks/:platform`.
    *   The `WebhookController` verifies the webhook's authenticity and then passes the payload to the `SyncCoordinatorService`.
    *   The `SyncCoordinatorService` uses the relevant platform adapter and mapper to process the incoming data and update the canonical `Products`, `ProductVariants`, or `InventoryLevels` in near real-time. It can also trigger updates to *other* linked platforms if the webhook signifies a change that needs to be propagated.

## sssync to Platform (Push Flow - Conceptual)

This flow describes how product and inventory changes made within sssync (e.g., through an admin interface, API calls, or as a result of a sync from another platform) would be pushed out to connected e-commerce platforms.

***Note:** While the foundational services (`SyncCoordinatorService`, `BaseAdapter` interface) are designed to support this, the platform-specific adapter methods for pushing data (e.g., `createProduct`, `updateProduct` on Shopify, Clover, Square) are currently placeholders and require full implementation.*

1.  **Canonical Data Change in sssync:**
    *   A `Product`, `ProductVariant`, or `InventoryLevel` record is created or updated within sssync's database. This could be initiated by:
        *   A user interacting with an sssync admin panel or a connected application.
        *   An API call to sssync's own API endpoints (e.g., `POST /api/products`).
        *   A sync operation pulling data from *another* platform that updates the canonical record.

2.  **Change Detection & Coordination:**
    *   The `SyncCoordinatorService` is notified of this canonical data change. This could happen through:
        *   Database triggers or listeners.
        *   Events emitted by services like `ProductsService` or `InventoryService` after they save data.
        *   Direct invocation if the change originates from an API controller that then calls the coordinator.

3.  **Adapter Invocation for Push:**
    *   The `SyncCoordinatorService` identifies which `PlatformConnections` are relevant (e.g., all active and enabled connections for the user associated with the changed data, or specific connections if the push is targeted).
    *   For each relevant platform connection:
        *   It retrieves the appropriate platform **Adapter** (e.g., `ShopifyAdapter`) using the `PlatformAdapterRegistry`.
        *   It calls the corresponding method on the adapter interface, providing the canonical data. For example:
            *   If a new canonical product/variant was created: `adapter.createProduct(connection, canonicalProduct, canonicalVariants, canonicalInventoryLevels)`
            *   If a canonical product/variant was updated: `adapter.updateProduct(connection, existingMapping, canonicalProduct, canonicalVariants, canonicalInventoryLevels)`
            *   If a canonical product was deleted/archived: `adapter.deleteProduct(connection, existingMapping)`
            *   If canonical inventory levels were updated: `adapter.updateInventoryLevels(connection, inventoryUpdatesArray)`

4.  **Platform Update (via Adapter Implementation):**
    *   The specific platform adapter (once fully implemented) takes the canonical data.
    *   It uses its **Mapper** to transform the canonical data into the platform's required API format (e.g., `ShopifyMapper.mapCanonicalProductToShopifyInput()`).
    *   It then uses its **API Client** to make the necessary API calls to the e-commerce platform to create, update, or delete the product/variant or update inventory levels.
    *   The adapter handles the response from the platform, including any errors, and might update the `PlatformProductMapping` with new platform IDs or sync status.

This conceptual flow provides the basis for a two-way synchronization system. The robustness will depend on the full implementation of the adapter push methods, conflict resolution strategies, and error handling.

# Testing the Full Sync Flow

This section provides a general guideline for testing the end-to-end synchronization capabilities of sssync, covering OAuth, data ingestion, reconciliation, and API data retrieval for platforms like Shopify, Clover, and Square.

**I. Prerequisites:**

*   **Environment:** NestJS app running, `.env` configured (Supabase, Redis, platform API keys/secrets/redirect URIs).
*   **Sandbox Accounts:** Active developer/sandbox accounts for Shopify, Clover, and Square.
*   **Initial Platform Data:** Populate each sandbox with 5-7 diverse products (simple, with variants, with/without SKUs/barcodes, varying inventory).
*   **Tools:** API Client (Postman, etc.), Supabase Dashboard, NestJS console logs.

**II. General Test Phases (Repeat for Each Platform):**

**Phase 1: OAuth Connection & Initial Setup**

1.  **User Authentication:** Obtain a JWT for a test user in your sssync system.
2.  **Initiate OAuth:**
    *   Call the platform-specific login endpoint (e.g., `GET /api/auth/shopify/login?userId=...&shop=...`, `GET /api/auth/clover/login?userId=...`, `GET /api/auth/square/login?userId=...`).
    *   Complete the platform's authentication flow.
    *   **Verify:** Successful redirect, new `PlatformConnections` entry in Supabase (enabled, credentials stored, correct `PlatformSpecificData`, status ok), success logs from `AuthService`.
3.  **List Connections:**
    *   Call `GET /api/platform-connections` (with JWT).
    *   **Verify:** The new connection appears in the response.

**Phase 2: Initial Scan, Data Ingestion & Mapping**
*(An `initial-scan` job should be queued automatically after successful connection)*

1.  **Monitor Scan:**
    *   **Verify:** Check application logs for `InitialScanProcessor` activity, adapter logs for data fetching from the platform, and `MappingService` logs for suggestion generation. `PlatformConnections.Status` may change. `ActivityLogs` should show scan events.
2.  **Fetch Mapping Suggestions:**
    *   Call `GET /api/sync/connections/:connectionId/mapping-suggestions` (with JWT).
    *   **Verify:** JSON array of platform products. For a new setup, `suggestedCanonicalVariant` should be `null`, `matchType: 'NONE'`.
3.  **Confirm Mappings (as "Create New"):**
    *   Call `POST /api/sync/connections/:connectionId/confirm-mappings` (with JWT). Body should instruct `action: "create"` for all platform products.
    *   **Verify:** New `Products`, `ProductVariants`, `PlatformProductMappings`, and `InventoryLevels` created in Supabase. Logs show successful data saving. `ActivityLogs` for mapping/creation. `PlatformConnections.Status` updates.

**Phase 3: Reconciliation Sync (Core Test)**

1.  **Introduce Changes on Platform:**
    *   Directly in the Shopify/Clover/Square admin:
        1.  Add 1-2 entirely new products.
        2.  Update inventory quantity for 1-2 already mapped products.
        3.  (Optional) Update title/price of a mapped product.
        4.  (Optional) Delete a mapped product.
2.  **Trigger Reconciliation:**
    *   Call `POST /api/sync/connection/:connectionId/reconcile` (with JWT).
    *   **Verify:** `InitialSyncService` queues job, `ReconciliationProcessor` picks it up. Adapter logs show fetching overviews, then full details for new items, and inventory for existing items.
3.  **Verify Reconciliation Results:**
    *   **New Products:** Should appear in sssync's `Products`, `ProductVariants`, with new `PlatformProductMappings` and correct `InventoryLevels`. `ActivityLogs` indicate discovery.
    *   **Inventory Changes:** `InventoryLevels` in sssync should reflect the updated quantities from the platform.
    *   **(Optional) Detail Changes:** Check if canonical `ProductVariants` (title/price) were updated. *Note: Reconciliation primarily focuses on new items and inventory; updating existing details might be a future enhancement or depend on sync rules.*
    *   **(Optional) Deleted Products:** Check `PlatformProductMapping` (e.g., `IsEnabled: false`, `SyncStatus` updated) and canonical `Product` (e.g., `IsArchived: true`). Check `ActivityLogs`.
    *   `PlatformConnections.LastSyncSuccessAt` should be updated.

**Phase 4: API Data Pulling & Verification**

1.  **Fetch Inventory via sssync API:**
    *   Example (Shopify): `GET /api/products/shopify/inventory?platformConnectionId=...&sync=false` (then `&sync=true`).
    *   **Verify:** `sync=false` returns current DB state. `sync=true` triggers live fetch from platform, updates DB, then returns fresh data. Compare with platform admin panel and Supabase.
2.  **Fetch Locations (Platform-Specific, e.g., Shopify):**
    *   Example (Shopify): `GET /api/products/shopify/locations?platformConnectionId=...`.
    *   **Verify:** Correct locations listed.
3.  **Fetch Locations with Products (Platform-Specific, e.g., Shopify):**
    *   Example (Shopify): `GET /api/products/shopify/locations-with-products?platformConnectionId=...&sync=false`.
    *   **Verify:** Aggregated view matches DB state.

**Phase 5: Product Updates (Canonical to Platform - Infrastructure Test)**
*(Full end-to-end push is conceptual as adapter methods are placeholders)*

1.  **Manually Change Canonical Data:** Create/update a `Product` or `ProductVariant` directly in Supabase.
2.  **Trigger Push (Conceptual/Manual):**
    *   If event-driven: Ensure `SyncCoordinatorService` listens to save events from `ProductsService`.
    *   If manual trigger needed for testing: Invoke `SyncCoordinatorService.handleCanonicalProductCreation(...)` or `handleCanonicalProductUpdate(...)`.
3.  **Verify (Logs):**
    *   `SyncCoordinatorService` logs detecting the change.
    *   Iteration through enabled connections.
    *   Attempted calls to adapter methods (e.g., `adapter.createProduct(...)`), which will log "not implemented" or throw the placeholder error. This verifies the coordinator logic.

This testing plan should help thoroughly vet the implemented synchronization features.

# System Robustness & Potential Improvements

**Current Strengths:**

*   **Modular Design:** Adapter pattern for easy extension to new platforms.
*   **Canonical Data Model:** Centralized schema for multi-platform consistency.
*   **OAuth Handled:** Secure authentication for Shopify, Clover, Square.
*   **Background Processing:** Queues for non-blocking operations.
*   **Basic Reconciliation:** Daily jobs for data consistency (inventory, new products from platform).
*   **API Documentation:** Foundation laid in `products.md`.

**Areas for Improvement & Future Considerations:**

*   **Error Handling & Resilience:**
    *   **Granular Retries & Backoff:** Implement in API clients for transient network issues or rate limits.
    *   **Dead-Letter Queues (DLQ):** For persistently failing jobs.
    *   **User-Facing Error Reporting:** Better visibility for users on sync failures (e.g., via `PlatformConnections.Status`, `ActivityLogs`, or UI notifications).
*   **Transactional Integrity:**
    *   Wrap multi-step database operations (e.g., creating Product + Variants + Mapping + Inventory) in database transactions to ensure atomicity.
*   **Outbound Rate Limiting:**
    *   Ensure adapters respect platform API rate limits when pushing data.
*   **Idempotency:**
    *   Critical for all create/update operations (platform-to-sssync and sssync-to-platform) to handle retries gracefully.
*   **Scalability of Reconciliation:**
    *   For very large catalogs, explore platform delta APIs (if available) or optimize overview fetching.
*   **Conflict Resolution (for sssync-to-platform):**
    *   Define strategies (last-write-wins, sssync-is-truth, platform-is-truth, manual resolution) for data conflicts when pushing updates.
*   **Data Validation & Transformation:**
    *   More robust validation of incoming platform data and handling of edge cases in mappers.
*   **Advanced Configuration Management:**
    *   Centralize more platform-specific configurations.
*   **Logging and Monitoring:**
    *   Structured logging (e.g., JSON), correlation IDs, integration with monitoring/alerting.
*   **User Control & Visibility (UI/UX Focus):**
    *   Dashboard for connection status, sync history, error logs.
    *   Manual sync triggers per connection.
    *   Pause/resume sync functionality.
*   **Automated Testing:**
    *   Comprehensive unit and integration tests.
*   **Two-Way Sync Strategy Definition:**
    *   Clearly define which system is the source of truth for which fields under different scenarios. May need to be configurable.
*   **Backup and Restore Strategy:**
    *   **Database Backups:** Leverage Supabase's automated backups.
    *   **Application-Level Snapshots:**
        *   Periodically, or before major operations, snapshot key canonical data (export to JSON/CSV in secure storage like S3). This allows for application-level recovery or user data export.
        *   This could be extended to allow users to download their canonical data.
    *   **Data Versioning:** For critical canonical data, consider implementing version history in Supabase tables (e.g., audit triggers or history tables) for easier rollback of specific changes.
    *   **"Google Docs" Style Versioning/Restore (Advanced):** This implies a much finer-grained audit trail, potentially using Event Sourcing. While powerful, it's a significant architectural addition. Periodic snapshots are a more immediate and achievable first step for application-level backups.

This provides a comprehensive view of data flows, testing, and areas for enhancement.




Read file: src/common/types/supabase.types.ts
You're right, that TypeScript error `Argument of type 'string | undefined' is not assignable to parameter of type 'string | null'` at `sync-coordinator.service.ts:300` for `canonicalVariant.Id` is problematic.

Looking at the type definition for `ProductVariant` in `src/common/types/supabase.types.ts` (which I've just read), the `Id` field is indeed `string`.
However, in `SyncCoordinatorService` (line 240-241 in `_executeProductCreationPush`), we have:
```typescript
                    const canonicalVariantsForAdapter: CanonicalProductVariant[] = supabaseVariants.map(v => ({
                        Id: v.Id!, // Asserting Id is present here
                        // ...
                    }));
```
And then later (around line 281):
```typescript
                    for (const canonicalVariant of canonicalVariantsForAdapter) {
                        const platformVariantId = platformVariantIds[canonicalVariant.Id!]; // Asserting Id is present
                        if (platformVariantId) {
                            // ...
                        } else {
                            // ...
                             await this.activityLogService.logActivity(
                                userId,
                                'ProductVariant',
                                canonicalVariant.Id, // Problem is here
                                //...
                            );
                        }
                    }
```
The issue is that `canonicalVariantsForAdapter` is an array of `CanonicalProductVariant`. The `CanonicalProductVariant` interface (from `src/platform-adapters/shopify/shopify.mapper.ts`, though not explicitly shown now, it's inferred from usage) might define `Id` as optional or `string | undefined`. Even if `supabaseVariants` (which are `SupabaseProductVariant[]`) all have `Id` as `string`, the mapping to `CanonicalProductVariant` might introduce this optionality if the `CanonicalProductVariant` interface itself declares `Id` as `string | undefined`.

The non-null assertion operator (`!`) in `canonicalVariant.Id!` tells TypeScript "I know this will not be null/undefined at this point." However, it seems the type of `canonicalVariant.Id` is still being inferred as `string | undefined` when passed to `logActivity`.

The most robust fix is to ensure `canonicalVariant.Id` is indeed a string before calling `logActivity` in that `else` block, or ensure the `CanonicalProductVariant` type definition for `Id` is `string`.

Given that `SupabaseProductVariant.Id` is `string`, and `CanonicalProductVariant.Id` *should* also be a non-nullable string (as it represents a persisted entity's ID), let's ensure the `logActivity` call is safe.

I'll adjust the `logActivity` call to handle the potential `undefined` for `canonicalVariant.Id` for the linter, although conceptually the ID should always be there if we're in this part of the logic.


Okay, that should address the TypeScript error by explicitly handling the case where `canonicalVariant.Id` might be perceived as `undefined` by the linter, providing `null` instead.

Now, let's describe the sync engine.

## Sync Engine Overview

Our sync engine is designed to keep product and inventory data consistent between a central canonical database (Supabase) and various connected e-commerce platforms (Shopify, Clover, Square). It handles initial data fetching, ongoing updates via webhooks, periodic reconciliation, and pushing local changes out to platforms.

**Core Components:**

1.  **Platform Adapters (`src/platform-adapters/`):**
    *   Each platform (Shopify, Clover, Square) has its own adapter.
    *   **API Client (`<platform>-api-client.service.ts`):** Handles all HTTP communication with the specific platform's API (fetching data, creating/updating/deleting products, inventory, etc.). Includes error handling, pagination, and authentication.
    *   **Mapper (`<platform>.mapper.ts`):** Translates data structures between the platform's format and our canonical `CanonicalProduct`, `CanonicalProductVariant`, and `CanonicalInventoryLevel` formats.
    *   **Adapter (`<platform>.adapter.ts`):** Orchestrates the use of the API client and mapper. Implements the `IPlatformAdapter` interface, providing standardized methods like `initialScan`, `processWebhook`, `createProduct`, `updateProduct`, `deleteProduct`, `getInventoryLevels`, `updateInventoryLevels`.
    *   **Module (`<platform>-adapter.module.ts`):** Bundles the adapter's components.
    *   `PlatformAdapterRegistry`: Allows dynamic retrieval of the correct adapter based on platform type.

2.  **Canonical Data Services (`src/canonical-data/`):**
    *   `ProductsService`: Manages CRUD operations for `Products` and `ProductVariants` in our Supabase database.
    *   `InventoryService`: Manages CRUD operations for `InventoryLevels` in Supabase.
    *   These services are the source of truth *after* data has been pulled and mapped from platforms or when new data is created within our system.

3.  **Platform Connections Service (`src/platform-connections/`):**
    *   Manages platform connection details (credentials, status, user ID, etc.) stored in the `PlatformConnections` table.
    *   Handles encryption/decryption of credentials.

4.  **Platform Product Mappings Service (`src/platform-product-mappings/`):**
    *   Manages the `PlatformProductMappings` table, which links our canonical `ProductVariantId` to platform-specific product and variant identifiers (`PlatformProductId`, `PlatformVariantId`). This is crucial for targeted updates.

5.  **Queueing System (BullMQ & Redis):**
    *   **`UltraLowQueueService` (not directly part of sync-engine but influences it):** A custom, less Redis-intensive queue for very frequent, low-priority tasks (primarily intended for rate limiting checks, but its existence informed the need to be mindful of Redis load).
    *   **`BullMQQueueService` (NestJS default BullMQ for specific high-load tasks):** Used for tasks requiring robust job management, retries, etc. Worker settings (`guardInterval`, `drainDelay`) were adjusted for `bullmq-high-queue` to reduce Redis polling.
    *   **Sync Engine Queues (defined in `sync-engine.constants.ts`):**
        *   `INITIAL_SCAN_QUEUE`: For initial fetching of all products/inventory from a newly connected platform. Processed by `InitialScanProcessor`.
        *   `INITIAL_SYNC_QUEUE`: For processing and saving the data fetched by the initial scan. Processed by `InitialSyncProcessor`. *(Currently, these processors are commented out in `sync-engine.module.ts`, suggesting this specific flow might be dormant or refactored. `initial-scan` *type* jobs are now handled by `bullmq-high-queue` worker and potentially general sync processors).*
        *   `WEBHOOK_PROCESSING_QUEUE`: Intended for processing incoming webhooks. (Currently, webhooks are handled synchronously by `SyncCoordinatorService.handleWebhook` but could be offloaded to this queue for more resilience).
        *   `RECONCILIATION_QUEUE`: For periodic reconciliation jobs. Processed by `ReconciliationProcessor`.
        *   `PUSH_OPERATIONS_QUEUE`: For pushing canonical data changes (create, update, delete products/inventory) out to connected platforms. Processed by `PushOperationsProcessor`.

6.  **Processors (`src/sync-engine/processors/`):**
    *   **`InitialScanProcessor`:** Handles jobs from `INITIAL_SCAN_QUEUE`. Fetches all product and inventory data from a platform via its adapter. (Currently, its registration is commented out).
    *   **`InitialSyncProcessor`:** Handles jobs from `INITIAL_SYNC_QUEUE`. Takes data from an initial scan, maps it, and saves it to the canonical database. (Currently, its registration is commented out).
    *   **`ReconciliationProcessor`:** Handles jobs from `RECONCILIATION_QUEUE`. Periodically fetches product overviews and inventory from platforms, compares with canonical data, identifies discrepancies (new/missing products, inventory mismatches), and triggers updates.
    *   **`PushOperationsProcessor`:** Handles jobs from `PUSH_OPERATIONS_QUEUE`. Takes details of a canonical data change (e.g., product created, inventory updated) and calls the appropriate `SyncCoordinatorService` method to execute the push to relevant platforms.

7.  **Core Services (`src/sync-engine/`):**
    *   **`MappingService`:** (Likely) Helps manage and translate data between platform-specific formats and the canonical model, potentially using the platform-specific mappers. (Its direct usage seems less prominent now that adapters have their own mappers).
    *   **`InitialSyncService`:** Coordinates the initial data synchronization process when a new platform is connected. Queues initial scan and reconciliation jobs.
    *   **`SyncCoordinatorService`:** The central nervous system for ongoing synchronization.
        *   Receives webhook events (via `WebhookController`) and delegates processing to the appropriate platform adapter.
        *   Provides methods (`handleCanonicalProductCreation`, etc.) that are called when canonical data changes. These methods now queue jobs onto the `PUSH_OPERATIONS_QUEUE`.
        *   Contains the detailed logic (`_executeProductCreationPush`, etc.) for actually performing the push operations to platforms, which are called by the `PushOperationsProcessor`.

8.  **Scheduled Tasks (`src/tasks/`):**
    *   `TasksService`: Uses `@nestjs/schedule` to run cron jobs.
    *   `handleDailyReconciliation`: A daily cron job (e.g., 3 AM) that fetches all enabled platform connections and queues a reconciliation job (`RECONCILIATION_QUEUE`) for each one via `InitialSyncService`.

**API Endpoints Related to Sync Engine:**

*   **`POST /webhooks/:platform` (handled by `WebhookController`):**
    *   Receives incoming webhook events from platforms (e.g., Shopify, Clover, Square).
    *   Identifies the platform and the specific connection.
    *   Passes the payload to `SyncCoordinatorService.handleWebhook`, which then delegates to the appropriate platform adapter's `processWebhook` method.
*   **`POST /sync/initial-scan/:connectionId` (handled by `SyncController`):**
    *   Triggers an initial scan for a given platform connection.
    *   Uses `InitialSyncService.queueInitialScanAndSync`.
*   **`POST /sync/reconcile/:connectionId` (handled by `SyncController`):**
    *   Triggers an ad-hoc reconciliation for a specific platform connection.
    *   Uses `InitialSyncService.queueReconciliationJob`.
*   **Other potential internal triggers (not direct API endpoints but drive the engine):**
    *   Calls to `SyncCoordinatorService.handleCanonicalProductCreation`, `handleCanonicalProductUpdate`, `handleCanonicalProductDeletion`, `handleCanonicalInventoryUpdate`. These are typically called from other services (e.g., `ProductsService` after a product is created/updated in the app's UI/API) to notify the sync engine of changes that need to be pushed out.

**Synchronization Scenarios Accounted For:**

1.  **Initial Connection & Bulk Data Import:**
    *   When a new platform is connected, an initial scan (`InitialScanProcessor` via `bullmq-high-queue` or a similar mechanism if `InitialScanProcessor` is dormant) fetches all existing products and inventory.
    *   This data is then mapped to the canonical format and saved to the Supabase DB (`InitialSyncProcessor` or integrated into the scan/reconciliation logic).
2.  **Real-time Updates via Webhooks:**
    *   Platforms send webhooks for events like "product created," "product updated," "inventory changed."
    *   `WebhookController` receives these, `SyncCoordinatorService` identifies the connection and adapter, and the adapter's `processWebhook` method handles the update (e.g., fetching full details if needed, mapping, and updating canonical data via `ProductsService` or `InventoryService`).
3.  **Periodic Reconciliation (Scheduled Task):**
    *   A daily cron job (`TasksService`) queues jobs for `ReconciliationProcessor`.
    *   **Discovery of New Products:** Fetches product overviews (e.g., IDs, SKUs, last updated timestamps) from each platform. Compares against `PlatformProductMappings`. If new platform products are found, it fetches their full details, maps them, creates canonical products/variants, and establishes new mappings.
    *   **Identification of Missing/Delisted Products:** If canonical products with mappings are no longer found on a platform during reconciliation, they can be logged or marked as inactive.
    *   **Inventory Level Reconciliation:** For all mapped products, it fetches live inventory levels from each platform location and updates the canonical `InventoryLevels` table. This corrects any drift that might have occurred if webhooks were missed or if there are other sources of inventory changes.
4.  **Pushing Canonical Changes to Platforms (via `PUSH_OPERATIONS_QUEUE`):**
    *   **Product Creation:** When a new product/variant is created in our system (e.g., through an admin UI or another API), `SyncCoordinatorService.handleCanonicalProductCreation` is called. It queues a job for `PushOperationsProcessor`, which then uses the appropriate adapter to create the product on all connected and enabled platforms. Mappings are created.
    *   **Product Updates:** When a canonical product/variant is updated, `SyncCoordinatorService.handleCanonicalProductUpdate` queues a job. The processor uses the adapter and existing mappings to update the product on linked platforms.
    *   **Product Deletion:** When a canonical product is deleted, `SyncCoordinatorService.handleCanonicalProductDeletion` queues a job. The processor uses the adapter to delete the product from linked platforms, and the corresponding mappings are removed.
    *   **Inventory Updates:** When canonical inventory levels are changed (e.g., manual adjustment, sale from an unlinked channel recorded in our DB), `SyncCoordinatorService.handleCanonicalInventoryUpdate` queues a job. The processor uses the adapter to update inventory levels on linked platforms for the specific variant and location.
5.  **Reduced Redis Load:**
    *   Increased `guardInterval` and `drainDelay` for the `bullmq-high-queue` worker.
    *   Significantly increased thresholds in `QueueManagerService` to ensure the less Redis-intensive `UltraLowQueueService` is used for ~99% of applicable cases (primarily rate limiting checks, not direct sync operations).
    *   Offloading intensive push operations to the `PUSH_OPERATIONS_QUEUE` prevents blocking and allows the main application threads to remain responsive.

**Circumstances Potentially NOT (or Partially) Accounted For / Areas for Improvement:**

1.  **Complex Product Structures & Options/Attributes Sync:**
    *   While creation of products with variants is handled, the depth of syncing complex option types, attribute names, and their specific mappings across platforms (which might have different ways of representing them, e.g., Shopify's 3-option limit vs. Clover's item groups/attributes/options) can be very challenging. Ensuring these are perfectly bidirectionally synced and maintained during updates requires very robust mapping logic in each adapter.
    *   The current Clover product creation logic (`orchestrateCloverProductCreation`) is quite detailed, but updates to these structures (e.g., adding a new option to an existing product) would need equally careful handling.
2.  **Order Syncing:**
    *   The current focus has been primarily on product and inventory. While `Orders` and `OrderItems` tables exist in the DB schema, the engine doesn't yet seem to actively sync orders from platforms or push orders created within the app to platforms. This is a major feature for many e-commerce integrations.
3.  **Product "Delisting" vs. "Deletion":**
    *   The current product deletion flow seems to delete the product from the platform. Some users might prefer a "delist" or "archive" option (mark as unavailable or hidden on the platform but not permanently delete). This would require changes in adapters and canonical data representation (e.g., an `IsPublishedToPlatform` flag in mappings).
4.  **Conflict Resolution During Bidirectional Sync:**
    *   If a product is updated simultaneously in our system and on a platform (between reconciliation cycles), how are conflicts resolved? The current model seems to prioritize either the platform (during webhook processing/reconciliation) or the canonical data (during push operations). A more sophisticated strategy (e.g., "last update wins," manual review queue for conflicts) might be needed for true bidirectional sync.
5.  **Platform-Specific Field Syncing:**
    *   Platforms often have many unique fields beyond the common ones (title, SKU, price, inventory). The `PlatformSpecificData` JSONB column in mappings and products/variants can store this, but actively syncing and managing these custom fields bidirectionally is complex and usually requires custom mapping UIs for users.
6.  **Token Refresh Mechanisms (Especially for Square & Clover):**
    *   While OAuth connection setup is present, robust, automated token refresh logic (especially for platforms with shorter-lived access tokens like Square) is critical for long-term unattended operation. Shopify tokens are typically long-lived. This needs to be built into the API clients or a central auth management service.
7.  **Error Handling Granularity & User Feedback:**
    *   The `ActivityLogService` provides good backend logging. However, surfacing critical sync errors to the end-user in a digestible way (e.g., in a dashboard, via notifications) so they can take action (e.g., reconnect a platform, review a mapping error) is important.
    *   Specific error types from platforms might require different retry strategies or user interventions.
8.  **Rate Limit Handling Sophistication:**
    *   Basic retry mechanisms are in BullMQ. However, more sophisticated, platform-aware rate limit handling (e.g., dynamic backoff based on platform response headers, per-connection rate limit queues) might be needed for very active stores or numerous connections. The `UltraLowQueueService` was a step in this direction for some operations.
9.  **Partial Success/Failures in Multi-Platform Pushes:**
    *   If a product push succeeds on Shopify but fails on Clover, how is this handled and communicated? The `PushOperationsProcessor` processes changes per-platform connection within its loops, so one platform's failure doesn't stop others, which is good. Logging captures this.
10. **Scalability for Very Large Catalogs/High Transaction Volumes:**
    *   While queues help, extremely large initial scans or very high numbers of webhooks/updates might require further optimization in database queries, API client batching, and potentially scaling out worker instances.
11. **Syncing of Other Entities:**
    *   Categories/Collections, Customers, Discounts, etc., are not currently part of the sync scope but are common requirements for full e-commerce integration.
12. **Dormant Queues (`initial-scan`, `initial-sync` named queues):**
    *   The original `INITIAL_SCAN_QUEUE` and `INITIAL_SYNC_QUEUE` and their processors are commented out. While `initial-scan` *type* jobs are handled, ensuring these queues are truly not being polled by any old BullMQ maintenance or worker configurations (if Redis keys still exist) is important for minimizing Redis load. If obsolete, they should be fully cleaned from Redis.

The engine has a solid foundation with distinct layers for platform interaction, canonical data management, and queued processing, addressing many core sync requirements. The areas not accounted for are typical of more advanced/mature sync systems and can be added iteratively.



Okay, let's break down what your application can do on the "sync side" based on the provided files, focusing on the API endpoints and the processes they initiate.

The primary controller for initiating synchronization tasks is `src/sync.controller.ts`. It works closely with `src/sync-engine/initial-sync.service.ts` to manage and queue various synchronization jobs.

Here's an overview of the synchronization capabilities and their corresponding endpoints:

**1. Initial Platform Scan & Data Ingestion**

*   **Purpose**: To perform an initial read of all products, variants, and relevant data (like inventory locations) from a newly connected e-commerce platform. This data is then saved into your canonical database, and mapping suggestions are generated to help link platform products to your system's products.
*   **Main Endpoint**: `POST /sync/connections/:connectionId/start-scan`
    *   **Action**: When you call this endpoint, the `InitialSyncService.queueInitialScanJob` method is invoked.
    *   This method queues an `'initial-scan'` job using the `QueueManagerService`.
    *   The `QueueManagerService` will decide whether to route this job to `UltraLowQueueService` (for low-demand scenarios) or `BullMQQueueService` (for high-demand).
    *   Ultimately, the `InitialScanProcessor.process` method will handle the job.
    *   **`InitialScanProcessor` does the following**:
        *   Updates the connection status to `'scanning'`.
        *   Fetches all relevant data (products, variants, locations, inventory) from the specified platform using the appropriate platform adapter.
        *   Maps the fetched platform data to your canonical product, variant, and inventory level structures.
        *   Saves these canonical entities to your Supabase database.
        *   Saves product images associated with the variants.
        *   Generates a scan summary (counts of products, variants, locations) and saves it.
        *   Generates mapping suggestions (e.g., potential matches based on SKU or barcode) between platform products and existing canonical products.
        *   Stores these suggestions and the summary in the `PlatformSpecificData` field of the `PlatformConnections` table.
        *   Updates the connection status to `'needs_review'`, indicating that user action is likely needed to confirm mappings.
*   **Supporting Endpoints**:
    *   `GET /sync/connections/:connectionId/scan-summary`: Retrieves the `InitialScanResult` (product/variant/location counts) stored after a scan.
    *   `GET /sync/connections/:connectionId/mapping-suggestions`: Fetches the `MappingSuggestion[]` generated during the initial scan, allowing the user to review potential matches.

**2. Confirming Mappings & Activating Full Sync**

*   **Purpose**: After an initial scan, the user reviews the mapping suggestions. This flow allows the user to confirm these mappings (e.g., link a platform product to an existing SSSync product, mark a platform product to be created as new in SSSync, or ignore it). Once confirmed, the actual initial synchronization can be activated.
*   **Endpoint 1**: `POST /sync/connections/:connectionId/confirm-mappings`
    *   **DTO**: `ConfirmMappingsDto` (expects `confirmedMatches` array and optional `syncRules`).
    *   **Action**: Calls `InitialSyncService.saveConfirmedMappings`, which in turn uses `MappingService.saveConfirmedMappings`.
    *   `MappingService` saves these confirmed actions (link, create, ignore) into `PlatformSpecificData` of the `PlatformConnection` and also creates direct links in the `PlatformProductMappings` table for items marked with `action: 'link'`.
*   **Endpoint 2**: `POST /sync/connections/:connectionId/activate-sync`
    *   **Action**: Calls `InitialSyncService.queueInitialSyncJob`.
    *   This method updates the connection status to `'syncing'`.
    *   It then queues an `'initial-sync'` job via `QueueManagerService`.
    *   Similar to the scan job, `QueueManagerService` routes this to `UltraLowQueueService` or `BullMQQueueService`.
    *   The `InitialSyncProcessor.process` method handles this job.
    *   **`InitialSyncProcessor` is responsible for**:
        *   Fetching the confirmed mappings.
        *   Iterating through platform data (fetched again or using a snapshot from the scan).
        *   Based on the `action` in `confirmedMappings` for each item:
            *   **'link'**: Creates or updates entries in `PlatformProductMappings`. Fetches platform inventory and updates canonical `InventoryLevels`.
            *   **'create'**: If sync rules allow, maps the platform product to canonical structures, creates new entries in your `Products` and `ProductVariants` tables, creates the `PlatformProductMapping`, and syncs inventory.
        *   All these database operations are intended to be within a Supabase transaction for data integrity.
        *   Finally, updates the connection status (e.g., to `'syncing'` or `'active'`) and `LastSyncSuccessAt`.
*   **Supporting Endpoint (currently a placeholder)**:
    *   `GET /sync/connections/:connectionId/sync-preview`: Intended to generate a preview of sync actions, but currently returns an empty actions array.

**3. Periodic Data Reconciliation**

*   **Purpose**: To ensure data consistency between your canonical store and the connected platforms over time. It identifies new products on the platform, products that might have been removed, and updates inventory levels for all mapped products.
*   **Endpoint**: `POST /sync/connection/:connectionId/reconcile`
    *   **Action**: Calls `InitialSyncService.queueReconciliationJob`.
    *   This method queues a job directly to the `RECONCILIATION_QUEUE` (a BullMQ named queue).
    *   The `ReconciliationProcessor.process` method handles this job.
    *   **`ReconciliationProcessor` does the following**:
        *   Logs the start of the job.
        *   Fetches product overviews (identifiers and minimal data) from the platform.
        *   Fetches all existing canonical product mappings for the connection.
        *   Compares the two lists to find:
            *   Products new on the platform (not yet mapped).
            *   Products mapped in SSSync but now missing on the platform.
        *   **For new platform products**: Fetches full details, maps them to canonical, saves new `Products`, `ProductVariants`, creates `PlatformProductMappings`, saves images, and initial `InventoryLevels`.
        *   **For missing platform products**: Logs a warning, indicating a review might be needed.
        *   **Inventory Reconciliation**: For all *actively mapped* products, it fetches live inventory levels from the platform and updates the corresponding records in your canonical `InventoryLevels` table.
        *   Updates `LastSyncSuccessAt` or `Status` on the connection and logs success/failure.
    *   **Note**: This reconciliation is rate-limited (1 job every 2 minutes per the processor config) to manage load.

**4. Handling Incoming Webhooks (Real-time Updates from Platforms)**

*   **Purpose**: To react to real-time changes happening on the e-commerce platforms (e.g., a product updated on Shopify, an order created on Clover).
*   **Endpoints**: These are defined in `src/sync-engine/webhook.controller.ts` (not explicitly provided in the file list, but its usage is clear from `SyncCoordinatorService`). Typically, these would be like `/webhooks/shopify`, `/webhooks/clover`, etc.
*   **Action**:
    *   The `WebhookController` receives the webhook, validates it (validation logic not detailed here but usually involves signature checking), and then calls `SyncCoordinatorService.handleWebhook`.
    *   `SyncCoordinatorService.handleWebhook` identifies the platform and the specific `PlatformConnection` based on information in the webhook payload or headers (e.g., Shopify's `x-shopify-shop-domain` header).
    *   It then delegates the actual processing to the `processWebhook` method of the corresponding platform adapter (e.g., `ShopifyAdapter.processWebhook`).
    *   **The adapter's `processWebhook` method is responsible for**:
        *   Parsing the platform-specific webhook payload.
        *   Determining the type of event (e.g., product update, inventory change).
        *   Fetching any additional necessary data from the platform related to the event.
        *   Updating the canonical data in your Supabase database by calling methods on services like `ProductsService` or `InventoryService`.
        *   For example, if a Shopify product is updated, the `ShopifyAdapter` would map the incoming Shopify product data to your `CanonicalProduct` and `CanonicalProductVariant` structures and then call `productsService.updateProductAndVariants(...)`.

**5. Pushing Canonical Data Changes to Platforms (SSSync -> Platforms)**

*   **Purpose**: When data changes in your canonical SSSync database (either through an admin interface, an import, or as a result of a webhook from *another* platform), these changes need tobe pushed out to all linked and enabled e-commerce platforms.
*   **Trigger**: This is not directly initiated by an API endpoint but happens as a consequence of your canonical data services (e.g., `ProductsService`, `InventoryService`) being called.
    *   When a canonical product is created, updated, or deleted, or when inventory levels change, these services call methods on `SyncCoordinatorService` like:
        *   `handleCanonicalProductCreation(productId, userId)`
        *   `handleCanonicalProductUpdate(productId, userId)`
        *   `handleCanonicalProductDeletion(productId, userId)`
        *   `handleCanonicalInventoryUpdate(variantId, userId)`
*   **Action**:
    *   These `handleCanonical...` methods in `SyncCoordinatorService` queue a job to the `PUSH_OPERATIONS_QUEUE` (a BullMQ named queue). The job data includes `userId`, `entityId` (product or variant ID), and `changeType`.
    *   The `PushOperationsProcessor.process` method handles these jobs.
    *   **`PushOperationsProcessor` does the following**:
        *   Based on the `changeType`, it calls a corresponding internal execution method in `SyncCoordinatorService` (e.g., `_executeProductCreationPush`, `_executeProductUpdatePush`, etc.).
        *   These `_execute...Push` methods contain the core logic:
            *   Fetch the relevant canonical product/variant and inventory data.
            *   Iterate through all enabled `PlatformConnections` for the user.
            *   For each connection:
                *   Get the appropriate platform adapter.
                *   Retrieve existing mappings if it's an update or deletion.
                *   Call the adapter's corresponding method (`createProduct`, `updateProduct`, `deleteProduct`, `updateInventoryLevels`).
                *   The adapter methods then make the necessary API calls to the e-commerce platform.
                *   After a successful push, new mappings might be created (for `createProduct`) or existing ones updated (e.g., `LastSyncedAt`, `SyncStatus`).
                *   Detailed activity logging is performed for success or failure of each push operation to each platform.
    *   **Note**: `PushOperationsProcessor` is also rate-limited (1 job every 1 minute per config) to manage API request rates to external platforms.

**Queue Management Strategy:**

*   **`QueueManagerService`**: Acts as a "traffic cop" for `'initial-scan'` and `'initial-sync'` jobs. It can dynamically switch between:
    *   **`UltraLowQueueService`**: A lightweight Redis list-based queue, intended for low-traffic scenarios to minimize Redis commands. It directly calls the `process` methods of `InitialScanProcessor` or `InitialSyncProcessor`.
    *   **`BullMQQueueService`**: Uses BullMQ for more robust queueing during high-traffic. It has a worker that processes jobs from the `bullmq-high-queue` and similarly calls the respective processor methods.
*   **Dedicated BullMQ Named Queues**:
    *   `RECONCILIATION_QUEUE`: Handled by `ReconciliationProcessor`.
    *   `PUSH_OPERATIONS_QUEUE`: Handled by `PushOperationsProcessor`.
    *   These queues are registered directly with BullMQ in `SyncEngineModule` and have their own specific configurations (like rate limiting and concurrency).

This covers the main synchronization functionalities exposed via API endpoints and the background processing involved. The system is designed to ingest data, allow user confirmation, perform initial and ongoing syncs, and react to changes from both your canonical store and the external platforms.
