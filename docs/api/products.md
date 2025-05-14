# Products API Documentation

## Authentication
All endpoints require authentication using the Supabase Auth token in the Authorization header:
```
Authorization: Bearer <supabase-auth-token>
```

## Rate Limiting
- `analyze` endpoint: 10 requests per minute
- `generate-details` endpoint: 5 requests per minute
- Other endpoints: Standard rate limits apply

## Endpoints

### 1. Analyze Images and Create Draft
Analyzes product images using AI and creates a draft product with initial details.

```http
POST /products/analyze
```

#### Request Body
```typescript
{
  "imageUris": string[];  // Array of image URLs to analyze
}
```

#### Response
```typescript
{
  "product": {
    "Id": string;
    "UserId": string;
    "Title": string;
    "Description": string | null;
    "IsArchived": boolean;
  };
  "variant": {
    "Id": string;
    "ProductId": string;
    "Sku": string;
    "Title": string;
    "Price": number;
    "Barcode": string | null;
    "Weight": number | null;
    "WeightUnit": string | null;
    "Options": any | null;
    "Description": string | null;
    "CompareAtPrice": number | null;
    "RequiresShipping": boolean | null;
    "IsTaxable": boolean | null;
    "TaxCode": string | null;
    "ImageId": string | null;
    "PlatformVariantId": string | null;
    "PlatformProductId": string | null;
  };
  "analysis": {
    "Id": string;
    "ProductId": string;
    "ContentType": string;
    "SourceApi": string;
    "GeneratedText": string;
    "Metadata": any;
    "IsActive": boolean;
    "CreatedAt": string;
    "UpdatedAt": string;
  } | null;
}
```

#### Example
```typescript
// Request
const response = await fetch('/products/analyze', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer <token>',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    imageUris: ['https://example.com/product-image.jpg']
  })
});

// Response
{
  "product": {
    "Id": "550e8400-e29b-41d4-a716-446655440000",
    "UserId": "user-123",
    "Title": "Untitled Product",
    "Description": null,
    "IsArchived": false
  },
  "variant": {
    "Id": "550e8400-e29b-41d4-a716-446655440001",
    "ProductId": "550e8400-e29b-41d4-a716-446655440000",
    "Sku": "DRAFT-550e8400",
    "Title": "Untitled Product",
    "Price": 0.00,
    "Barcode": null,
    "Weight": null,
    "WeightUnit": null,
    "Options": null,
    "Description": null,
    "CompareAtPrice": null,
    "RequiresShipping": null,
    "IsTaxable": null,
    "TaxCode": null,
    "ImageId": null,
    "PlatformVariantId": null,
    "PlatformProductId": null
  },
  "analysis": null
}
```

### 2. Generate Details for Draft
Generates AI-powered product details for an existing draft product.

```http
POST /products/generate-details
```

#### Request Body
```typescript
{
  "productId": string;
  "variantId": string;
  "imageUris": string[];  // Array of image URLs to use for generation
  "coverImageIndex": number;  // Index of the cover image in imageUris array
  "selectedPlatforms": string[];  // Array of target platforms (e.g., ['shopify', 'amazon'])
  "selectedMatch": {  // Optional: Selected visual match from analysis
    "title": string;
    "source": string;
    "price": {
      "value": string;
      "currency": string;
    };
    "snippet": string;
  } | null;
}
```

#### Response
```typescript
{
  "generatedDetails": {
    [platform: string]: {  // e.g., 'shopify', 'amazon'
      title: string;
      description: string;
      price: number;
      // Platform-specific fields
    };
  } | null;
}
```

#### Example
```typescript
// Request
const response = await fetch('/products/generate-details', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer <token>',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    productId: "550e8400-e29b-41d4-a716-446655440000",
    variantId: "550e8400-e29b-41d4-a716-446655440001",
    imageUris: ["https://example.com/product-1.jpg", "https://example.com/product-2.jpg"],
    coverImageIndex: 0,
    selectedPlatforms: ["shopify", "amazon"],
    selectedMatch: {
      title: "Example Product",
      source: "example.com",
      price: {
        value: "29.99",
        currency: "USD"
      },
      snippet: "Example product description"
    }
  })
});

// Response
{
  "generatedDetails": {
    "shopify": {
      "title": "Premium Example Product",
      "description": "High-quality example product...",
      "price": 29.99,
      "vendor": "Your Brand",
      "productType": "Example Category"
    },
    "amazon": {
      "title": "Premium Example Product",
      "description": "High-quality example product...",
      "price": 29.99,
      "bulletPoints": ["Feature 1", "Feature 2"],
      "category": "Example Category"
    }
  }
}
```

### 3. Publish to Shopify
Publishes a product to Shopify with inventory management.

```http
POST /products/:id/publish/shopify
```

#### Request Body
```typescript
{
  "platformConnectionId": string;  // ID of the Shopify platform connection
  "locations": Array<{
    "locationId": string;  // Shopify location ID
    "quantity": number;    // Initial inventory quantity
  }>;
  "options": {
    "status"?: "ACTIVE" | "DRAFT" | "ARCHIVED";  // Default: "ACTIVE"
    "vendor"?: string;
    "productType"?: string;
    "tags"?: string[];
  };
}
```

#### Response
```typescript
{
  "success": boolean;
  "productId": string;  // Shopify product ID
  "operationId": string;  // Operation ID for tracking
}
```

#### Example
```typescript
// Request
const response = await fetch('/products/550e8400-e29b-41d4-a716-446655440000/publish/shopify', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer <token>',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    platformConnectionId: "conn-123",
    locations: [
      { locationId: "loc-1", quantity: 10 },
      { locationId: "loc-2", quantity: 5 }
    ],
    options: {
      status: "ACTIVE",
      vendor: "Your Brand",
      productType: "Example Category",
      tags: ["new", "featured"]
    }
  })
});

// Response
{
  "success": true,
  "productId": "shopify-product-123",
  "operationId": "op-123"
}
```

### 4. Create Product
Creates a new product with a variant directly.

```http
POST /products
```

#### Request Body
```typescript
{
  "userId": string;
  "variantData": {
    "Sku": string;
    "Title": string;
    "Description"?: string;
    "Price": number;
    "Barcode"?: string;
    "Weight"?: number;
    "WeightUnit"?: string;
    "Options"?: any;
    "CompareAtPrice"?: number;
    "RequiresShipping"?: boolean;
    "IsTaxable"?: boolean;
    "TaxCode"?: string;
  };
}
```

#### Response
Same as the analyze endpoint response.

#### Example
```typescript
// Request
const response = await fetch('/products', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer <token>',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    userId: "user-123",
    variantData: {
      Sku: "PROD-123",
      Title: "Example Product",
      Description: "Product description",
      Price: 29.99,
      Barcode: "123456789",
      Weight: 1.5,
      WeightUnit: "POUNDS",
      Options: { size: ["S", "M", "L"] },
      RequiresShipping: true,
      IsTaxable: true
    }
  })
});

// Response
{
  "product": {
    "Id": "550e8400-e29b-41d4-a716-446655440000",
    "UserId": "user-123",
    "Title": "Example Product",
    "Description": null,
    "IsArchived": false
  },
  "variant": {
    "Id": "550e8400-e29b-41d4-a716-446655440001",
    "ProductId": "550e8400-e29b-41d4-a716-446655440000",
    "Sku": "PROD-123",
    "Title": "Example Product",
    "Price": 29.99,
    "Barcode": "123456789",
    "Weight": 1.5,
    "WeightUnit": "POUNDS",
    "Options": { "size": ["S", "M", "L"] },
    "Description": "Product description",
    "CompareAtPrice": null,
    "RequiresShipping": true,
    "IsTaxable": true,
    "TaxCode": null,
    "ImageId": null,
    "PlatformVariantId": null,
    "PlatformProductId": null
  }
}
```

### 5. Get Shopify Locations
Fetches all available locations for a Shopify store.

```http
GET /products/shopify/locations?platformConnectionId=<connection-id>
```

#### Query Parameters
```typescript
{
  "platformConnectionId": string;  // ID of the Shopify platform connection
}
```

#### Response
```typescript
{
  "locations": Array<{
    "id": string;           // Shopify location ID
    "name": string;         // Location name
    "address1": string;     // Street address
    "address2": string | null;
    "city": string;
    "province": string;
    "country": string;
    "zip": string;
    "phone": string | null;
    "provinceCode": string;
    "countryCode": string;
    "countryName": string;
    "legacy": boolean;      // Whether this is a legacy location
    "active": boolean;      // Whether this location is active
    "adminGraphqlApiId": string;  // GraphQL API ID
    "localizedCountryName": string;
    "localizedProvinceName": string;
  }>;
}
```

#### Example
```typescript
// Request
const response = await fetch('/products/shopify/locations?platformConnectionId=conn-123', {
  method: 'GET',
  headers: {
    'Authorization': 'Bearer <token>'
  }
});

// Response
{
  "locations": [
    {
      "id": "loc-1",
      "name": "Main Warehouse",
      "address1": "123 Main St",
      "address2": null,
      "city": "San Francisco",
      "province": "California",
      "country": "United States",
      "zip": "94105",
      "phone": "+1-555-0123",
      "provinceCode": "CA",
      "countryCode": "US",
      "countryName": "United States",
      "legacy": false,
      "active": true,
      "adminGraphqlApiId": "gid://shopify/Location/123456789",
      "localizedCountryName": "United States",
      "localizedProvinceName": "California"
    },
    {
      "id": "loc-2",
      "name": "East Coast Warehouse",
      "address1": "456 East Ave",
      "address2": "Suite 100",
      "city": "New York",
      "province": "New York",
      "country": "United States",
      "zip": "10001",
      "phone": "+1-555-0124",
      "provinceCode": "NY",
      "countryCode": "US",
      "countryName": "United States",
      "legacy": false,
      "active": true,
      "adminGraphqlApiId": "gid://shopify/Location/987654321",
      "localizedCountryName": "United States",
      "localizedProvinceName": "New York"
    }
  ]
}
```

#### Error Responses
This endpoint may return the following additional error responses:

```typescript
// 400 Bad Request - Invalid platform connection
{
  "statusCode": 400,
  "message": "Invalid Shopify platform connection";
  "error": "Bad Request";
}

// 403 Forbidden - Shopify feature not enabled
{
  "statusCode": 403,
  "message": "Feature not enabled for your subscription";
  "error": "Forbidden";
}
```

### 6. Get Shopify Inventory
Fetches and optionally syncs inventory levels for all products in a Shopify store.

```http
GET /products/shopify/inventory?platformConnectionId=<connection-id>&sync=<boolean>
```

#### Query Parameters
```typescript
{
  "platformConnectionId": string;  // ID of the Shopify platform connection
  "sync": boolean;                 // Optional: Whether to sync with Shopify (default: false)
}
```

#### Response
```typescript
{
  "inventory": Array<{
    "variantId": string;           // Your internal variant ID
    "sku": string;                 // Product SKU
    "title": string;              // Product title
    "locations": Array<{
      "locationId": string;        // Shopify location ID
      "locationName": string;      // Location name
      "quantity": number;          // Current inventory quantity
      "updatedAt": string;         // Last update timestamp
    }>;
    "productId": string;           // Your internal product ID
    "platformVariantId": string;   // Shopify variant ID
    "platformProductId": string;   // Shopify product ID
  }>;
  "lastSyncedAt": string | null;   // Timestamp of last successful sync
}
```

#### Example
```typescript
// Request (without sync)
const response = await fetch('/products/shopify/inventory?platformConnectionId=conn-123', {
  method: 'GET',
  headers: {
    'Authorization': 'Bearer <token>'
  }
});

// Request (with sync)
const response = await fetch('/products/shopify/inventory?platformConnectionId=conn-123&sync=true', {
  method: 'GET',
  headers: {
    'Authorization': 'Bearer <token>'
  }
});

// Response
{
  "inventory": [
    {
      "variantId": "var-123",
      "sku": "PROD-123",
      "title": "Example Product",
      "locations": [
        {
          "locationId": "loc-1",
          "locationName": "Main Warehouse",
          "quantity": 10,
          "updatedAt": "2024-03-20T15:30:00Z"
        },
        {
          "locationId": "loc-2",
          "locationName": "East Coast Warehouse",
          "quantity": 5,
          "updatedAt": "2024-03-20T15:30:00Z"
        }
      ],
      "productId": "prod-123",
      "platformVariantId": "shopify-var-123",
      "platformProductId": "shopify-prod-123"
    }
  ],
  "lastSyncedAt": "2024-03-20T15:30:00Z"
}
```

#### Error Responses
This endpoint may return the following additional error responses:

```typescript
// 400 Bad Request - Invalid platform connection
{
  "statusCode": 400,
  "message": "Invalid Shopify platform connection";
  "error": "Bad Request";
}

// 403 Forbidden - Shopify feature not enabled
{
  "statusCode": 403,
  "message": "Feature not enabled for your subscription";
  "error": "Forbidden";
}

// 429 Too Many Requests - Rate limit exceeded
{
  "statusCode": 429,
  "message": "Too Many Requests";
  "error": "Too Many Requests";
}
```

#### Notes
- The endpoint is rate-limited to 1 request per 10 minutes
- When `sync=true`, the endpoint will:
  1. Fetch the latest inventory levels from Shopify
  2. Update the local database with the new levels
  3. Return the updated inventory data
- When `sync=false`, the endpoint returns the cached inventory data from the local database
- The `lastSyncedAt` timestamp indicates when the data was last synchronized with Shopify
- Inventory levels are tracked per variant and location
- The endpoint requires the `shopify` feature to be enabled

### 7. Get Shopify Locations with Products
Fetches all locations and their associated products in a single call. This is the recommended endpoint for displaying location-based inventory management.

```http
GET /products/shopify/locations-with-products?platformConnectionId=<connection-id>&sync=<boolean>
```

#### Query Parameters
```typescript
{
  "platformConnectionId": string;  // ID of the Shopify platform connection
  "sync": boolean;                 // Optional: Whether to sync with Shopify (default: false)
}
```

#### Response
```typescript
{
  "locations": Array<{
    "id": string;           // Shopify location ID
    "name": string;         // Location name
    "isActive": boolean;    // Whether the location is active
    "products": Array<{     // Products available at this location
      "variantId": string;  // Your internal variant ID
      "sku": string;        // Product SKU
      "title": string;      // Product title
      "quantity": number;   // Current inventory quantity at this location
      "updatedAt": string;  // Last update timestamp
      "productId": string;  // Your internal product ID
      "platformVariantId": string;   // Shopify variant ID
      "platformProductId": string;   // Shopify product ID
    }>;
  }>;
  "lastSyncedAt": string | null;   // Timestamp of last successful sync
}
```

#### Example
```typescript
// Request (without sync)
const response = await fetch('/products/shopify/locations-with-products?platformConnectionId=conn-123', {
  method: 'GET',
  headers: {
    'Authorization': 'Bearer <token>'
  }
});

// Request (with sync)
const response = await fetch('/products/shopify/locations-with-products?platformConnectionId=conn-123&sync=true', {
  method: 'GET',
  headers: {
    'Authorization': 'Bearer <token>'
  }
});

// Response
{
  "locations": [
    {
      "id": "gid://shopify/Location/123456789",
      "name": "Main Warehouse",
      "isActive": true,
      "products": [
        {
          "variantId": "var-123",
          "sku": "PROD-123",
          "title": "Example Product",
          "quantity": 10,
          "updatedAt": "2024-03-20T15:30:00Z",
          "productId": "prod-123",
          "platformVariantId": "shopify-var-123",
          "platformProductId": "shopify-prod-123"
        }
      ]
    },
    {
      "id": "gid://shopify/Location/987654321",
      "name": "East Coast Warehouse",
      "isActive": true,
      "products": [
        {
          "variantId": "var-123",
          "sku": "PROD-123",
          "title": "Example Product",
          "quantity": 5,
          "updatedAt": "2024-03-20T15:30:00Z",
          "productId": "prod-123",
          "platformVariantId": "shopify-var-123",
          "platformProductId": "shopify-prod-123"
        }
      ]
    }
  ],
  "lastSyncedAt": "2024-03-20T15:30:00Z"
}
```

#### Error Responses
This endpoint may return the following error responses:

```typescript
// 400 Bad Request - Invalid platform connection
{
  "statusCode": 400,
  "message": "Invalid Shopify platform connection";
  "error": "Bad Request";
}

// 403 Forbidden - Shopify feature not enabled
{
  "statusCode": 403,
  "message": "Feature not enabled for your subscription";
  "error": "Forbidden";
}

// 429 Too Many Requests - Rate limit exceeded
{
  "statusCode": 429,
  "message": "Too Many Requests";
  "error": "Too Many Requests";
}
```

#### Notes
- The endpoint is rate-limited to 1 request per 10 minutes
- When `sync=true`, the endpoint will:
  1. Fetch the latest inventory levels from Shopify
  2. Update the local database with the new levels
  3. Return the updated data grouped by location
- When `sync=false`, the endpoint returns the cached data from the local database
- The `lastSyncedAt` timestamp indicates when the data was last synchronized with Shopify
- This endpoint is optimized for location-based inventory management interfaces
- The endpoint requires the `shopify` feature to be enabled

## Error Responses

All endpoints may return the following error responses:

```typescript
// 400 Bad Request
{
  "statusCode": 400,
  "message": string;
  "error": "Bad Request";
}

// 401 Unauthorized
{
  "statusCode": 401,
  "message": "Unauthorized";
  "error": "Unauthorized";
}

// 404 Not Found
{
  "statusCode": 404,
  "message": string;
  "error": "Not Found";
}

// 429 Too Many Requests
{
  "statusCode": 429,
  "message": "Too Many Requests";
  "error": "Too Many Requests";
}

// 500 Internal Server Error
{
  "statusCode": 500,
  "message": string;
  "error": "Internal Server Error";
}
```

## Feature Usage

Some endpoints require specific feature flags to be enabled for the user's subscription:

- `analyze` and `generate-details` endpoints require the `aiScans` feature
- `publish/shopify` endpoint requires the `shopify` feature

The API will return a 403 Forbidden error if the required feature is not enabled:

```typescript
{
  "statusCode": 403,
  "message": "Feature not enabled for your subscription";
  "error": "Forbidden";
}
```

## Shopify Integration Endpoints

### Get Shopify Locations
Retrieves all available locations from a Shopify store.

**Endpoint:** `GET /products/shopify/locations?platformConnectionId=<connection-id>`

**Query Parameters:**
- `platformConnectionId` (required): string - ID of the Shopify platform connection

**Response (200 OK):**
```json
{
  "locations": [
    {
      "id": "gid://shopify/Location/123456789",
      "name": "Main Warehouse",
      "isActive": true
    }
  ]
}
```

**Error Responses:**
- 400 Bad Request: Invalid platform connection ID
- 403 Forbidden: Shopify feature not enabled
- 429 Too Many Requests: Rate limit exceeded (1 request per 10 minutes)

### Get Shopify Inventory
Retrieves inventory levels for all products in a Shopify store.

**Endpoint:** `GET /products/shopify/inventory?platformConnectionId=<connection-id>&sync=<boolean>`

**Query Parameters:**
- `platformConnectionId` (required): string - ID of the Shopify platform connection
- `sync` (optional): boolean - Whether to sync with Shopify (default: false)

**Response (200 OK):**
```json
{
  "inventory": [
    {
      "variantId": "var-123",
      "sku": "PROD-123",
      "title": "Example Product",
      "locations": [
        {
          "locationId": "gid://shopify/Location/123456789",
          "locationName": "Main Warehouse",
          "quantity": 10,
          "updatedAt": "2024-03-20T15:30:00Z"
        }
      ],
      "productId": "prod-123",
      "platformVariantId": "shopify-var-123",
      "platformProductId": "shopify-prod-123"
    }
  ],
  "lastSyncedAt": "2024-03-20T15:30:00Z"
}
```

**Error Responses:**
- 400 Bad Request: Invalid platform connection ID
- 403 Forbidden: Shopify feature not enabled
- 429 Too Many Requests: Rate limit exceeded (1 request per 10 minutes)

### Get Shopify Locations with Products
Retrieves all locations along with their associated products and inventory levels in a single call.

**Endpoint:** `GET /products/shopify/locations-with-products?platformConnectionId=<connection-id>&sync=<boolean>`

**Query Parameters:**
- `platformConnectionId` (required): string - ID of the Shopify platform connection
- `sync` (optional): boolean - Whether to sync with Shopify (default: false)

**Response (200 OK):**
```json
{
  "locations": [
    {
      "id": "gid://shopify/Location/123456789",
      "name": "Main Warehouse",
      "isActive": true,
      "products": [
        {
          "variantId": "var-123",
          "sku": "PROD-123",
          "title": "Example Product",
          "quantity": 10,
          "updatedAt": "2024-03-20T15:30:00Z",
          "productId": "prod-123",
          "platformVariantId": "shopify-var-123",
          "platformProductId": "shopify-prod-123"
        }
      ]
    }
  ],
  "lastSyncedAt": "2024-03-20T15:30:00Z"
}
```

**Error Responses:**
- 400 Bad Request: Invalid platform connection ID
- 403 Forbidden: Shopify feature not enabled
- 429 Too Many Requests: Rate limit exceeded (1 request per 10 minutes)

**Notes:**
1. All endpoints are rate-limited to 1 request per 10 minutes
2. The `sync` parameter determines whether to fetch fresh data from Shopify:
   - When `sync=true`, the endpoint will fetch the latest data from Shopify and update the local cache
   - When `sync=false` (default), the endpoint will return cached data if available
3. The `lastSyncedAt` timestamp indicates when the data was last synchronized with Shopify
4. All endpoints require a valid Shopify platform connection with the `shopify` feature enabled
5. The locations-with-products endpoint is optimized for building location-based UIs, as it organizes the data by location first

**Example Usage:**
```typescript
// Fetch locations with their products
const response = await fetch('/products/shopify/locations-with-products?platformConnectionId=conn_123&sync=true', {
  headers: {
    'Authorization': 'Bearer your-token',
    'Content-Type': 'application/json'
  }
});

const data = await response.json();
// data.locations contains an array of locations, each with its products
```

**Best Practices:**
1. Use the locations-with-products endpoint when building location-based UIs
2. Use the inventory endpoint when you need a flat list of all inventory levels
3. Use the locations endpoint when you only need location information
4. Set `sync=true` only when you need fresh data from Shopify
5. Cache the response data on the client side and use the `lastSyncedAt` timestamp to determine when to refresh

**Example Usage:**
```typescript
// Fetch locations with their products
const response = await fetch('/products/shopify/locations-with-products?platformConnectionId=conn_123&sync=true', {
  headers: {
    'Authorization': 'Bearer your-token',
    'Content-Type': 'application/json'
  }
});

const data = await response.json();
// data.locations contains an array of locations, each with its products
```

**Best Practices:**
1. Use the locations-with-products endpoint when building location-based UIs
2. Use the inventory endpoint when you need a flat list of all inventory levels
3. Use the locations endpoint when you only need location information
4. Set `sync=true` only when you need fresh data from Shopify
5. Cache the response data on the client side and use the `lastSyncedAt` timestamp to determine when to refresh

# Shopify Integration Documentation

## Critical: Throttling and Rate Limiting Issues

### Current Implementation
- All Shopify endpoints are currently throttled to 1 request per 10 minutes (600,000ms) using NestJS's ThrottlerGuard
- This is causing issues with legitimate use cases (e.g., initial app load) while still allowing excessive requests
- We're seeing ~30 requests/minute despite the throttling, indicating a potential issue with the throttling implementation

### Immediate Actions Required
1. **Throttling Adjustment**
   ```typescript
   // Current implementation (too restrictive):
   @Throttle({ default: { limit: 1, ttl: 600000 }}) // 1 request per 10 minutes
   
   // Recommended implementation:
   @Throttle({ default: { limit: 5, ttl: 60000 }}) // 5 requests per minute
   ```

2. **Request Logging Implementation**
   Add this middleware to `src/common/middleware/request-logger.middleware.ts`:
   ```typescript
   import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
   import { Request, Response, NextFunction } from 'express';

   @Injectable()
   export class RequestLoggerMiddleware implements NestMiddleware {
     private readonly logger = new Logger('RequestLogger');

     use(req: Request, res: Response, next: NextFunction) {
       const { method, originalUrl, query, body, headers } = req;
       const userAgent = headers['user-agent'];
       const userId = headers['x-user-id']; // Adjust based on your auth header

       this.logger.log(
         `[${method}] ${originalUrl} - User: ${userId} - UA: ${userAgent}` +
         `\nQuery: ${JSON.stringify(query)}` +
         `\nBody: ${JSON.stringify(body)}`
       );

       // Log response
       const originalSend = res.send;
       res.send = function (body) {
         this.logger.log(
           `[${method}] ${originalUrl} - Status: ${res.statusCode}` +
           `\nResponse: ${typeof body === 'string' ? body : JSON.stringify(body)}`
         );
         return originalSend.call(this, body);
       };

       next();
     }
   }
   ```

3. **Apply Middleware**
   In `src/app.module.ts`:
   ```typescript
   export class AppModule implements NestModule {
     configure(consumer: MiddlewareConsumer) {
       consumer
         .apply(RequestLoggerMiddleware)
         .forRoutes('*');
     }
   }
   ```

### Debugging Steps
1. **Identify Source of Requests**
   ```bash
   # Using the request logger, monitor requests:
   tail -f your-app.log | grep "GET /products/shopify"
   
   # Or use a more specific pattern:
   tail -f your-app.log | grep "GET /products/shopify/locations"
   ```

2. **Check Frontend Implementation**
   - Review all components that fetch Shopify data
   - Look for:
     - Uncontrolled `useEffect` hooks
     - Missing dependency arrays
     - Multiple components fetching the same data
     - Polling intervals that are too frequent

3. **Common Frontend Issues to Fix**
   ```typescript
   // BAD: Polling every second
   useEffect(() => {
     const interval = setInterval(() => {
       fetchShopifyData();
     }, 1000);
     return () => clearInterval(interval);
   }, []);

   // GOOD: Poll every minute, with proper cleanup
   useEffect(() => {
     const fetchData = async () => {
       try {
         const data = await fetchShopifyData();
         setInventoryData(data);
       } catch (error) {
         if (error.status === 429) {
           // Handle rate limit - maybe show a message
           console.warn('Rate limited, will retry in 1 minute');
         }
       }
     };

     fetchData(); // Initial fetch
     const interval = setInterval(fetchData, 60000); // Poll every minute
     return () => clearInterval(interval);
   }, [fetchShopifyData]); // Proper dependency
   ```

4. **Implement Caching**
   ```typescript
   // In your frontend service:
   private cache = new Map<string, { data: any; timestamp: number }>();
   private CACHE_TTL = 5 * 60 * 1000; // 5 minutes

   async getShopifyData(connectionId: string, forceSync = false) {
     const cacheKey = `shopify-${connectionId}`;
     const cached = this.cache.get(cacheKey);
     
     if (!forceSync && cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
       return cached.data;
     }

     const data = await this.api.get(`/products/shopify/inventory?platformConnectionId=${connectionId}&sync=${forceSync}`);
     this.cache.set(cacheKey, { data, timestamp: Date.now() });
     return data;
   }
   ```

## API Endpoints

[Previous endpoint documentation remains the same...]

## Best Practices for Frontend Implementation

1. **Data Fetching Strategy**
   - Use a single source of truth (e.g., React Query, Redux) for Shopify data
   - Implement proper caching with TTL
   - Use optimistic updates for inventory changes
   - Implement proper error handling for 429 responses

2. **Component Structure**
   ```typescript
   // Example of a well-structured inventory component
   const ShopifyInventory: React.FC = () => {
     const [isLoading, setIsLoading] = useState(false);
     const [error, setError] = useState<Error | null>(null);
     const { data, refetch } = useQuery(
       'shopify-inventory',
       () => fetchShopifyData(),
       {
         staleTime: 5 * 60 * 1000, // Consider data fresh for 5 minutes
         cacheTime: 30 * 60 * 1000, // Keep in cache for 30 minutes
         retry: (failureCount, error) => {
           if (error.status === 429) return false; // Don't retry on rate limit
           return failureCount < 3;
         }
       }
     );

     // Manual refresh handler
     const handleRefresh = async () => {
       try {
         setIsLoading(true);
         await refetch();
       } catch (error) {
         setError(error);
       } finally {
         setIsLoading(false);
       }
     };

     return (
       <div>
         <button onClick={handleRefresh} disabled={isLoading}>
           Refresh Inventory
         </button>
         {error?.status === 429 && (
           <div className="error">
             Rate limited. Please wait before trying again.
           </div>
         )}
         {/* Render inventory data */}
       </div>
     );
   };
   ```

3. **Error Handling**
   - Implement proper error boundaries
   - Show user-friendly messages for rate limits
   - Provide manual refresh options
   - Log errors for debugging

4. **Performance Optimization**
   - Use pagination for large datasets
   - Implement virtual scrolling for long lists
   - Use proper memoization
   - Implement proper loading states

## Monitoring and Maintenance

1. **Logging Strategy**
   - Use the provided RequestLoggerMiddleware
   - Monitor rate limit hits
   - Track sync operations
   - Log all Shopify API calls

2. **Alerting**
   - Set up alerts for:
     - High rate of 429 responses
     - Failed sync operations
     - Unusual request patterns
     - API errors from Shopify

3. **Regular Maintenance**
   - Review and adjust throttling limits
   - Monitor cache hit rates
   - Review and update error handling
   - Check for unused or duplicate API calls

## Next Steps for Backend Dev

1. **Immediate Actions**
   - Implement the RequestLoggerMiddleware
   - Adjust throttling limits
   - Review and update error handling
   - Add proper monitoring

2. **Technical Debt**
   - Consider implementing a proper caching layer
   - Add more comprehensive logging
   - Implement proper rate limiting per user/connection
   - Add metrics collection

3. **Future Improvements**
   - Consider implementing WebSocket for real-time updates
   - Add bulk operations for inventory updates
   - Implement proper retry mechanisms
   - Add more comprehensive testing

Queue Responsiveness (Ultra-Low Queue)
You're correct. The ultra-low-queue (which uses simple Redis lists) is designed for on-demand processing.
No Polling: It does not have a background worker that constantly polls Redis. This means zero Redis commands when it's idle.
Instant Enqueue: When QueueManager.enqueueJob(jobData) is called, it's a direct LPUSH to Redis – very fast.
Processing Delay: The delay comes from when you decide to process jobs.
If you call QueueManager.processNextJob() or QueueManager.processAllJobs() immediately after an HTTP request that needs a job done (or in response to a webhook), the processing will start almost instantly.
If you set up a cron job to call processAllJobs() (e.g., every few seconds or minutes), then jobs will wait until the cron triggers.
In your current setup with the QueueManager:
The recordRequest() function is called on every enqueueJob.
The checkAndSwitchQueue() function then decides if it should switch to the BullMQ (higher throughput) queue based on your defined thresholds (more than 5 requests/second for more than 15 seconds).
When NOT in high-throughput mode (i.e., using ultra-low-queue), jobs are simply added to the Redis list. They will only be processed when something in your application explicitly calls QueueManager.processNextJob() or QueueManager.processAllJobs().
To ensure "basically instant" processing for the low-traffic queue, you need to decide when to trigger the processing.
For example, if a customer action queues a job and they need to see the result quickly, the controller handling that action might call QueueManager.processNextJob() right after QueueManager.enqueueJob().
Throttling and User Experience
Your current throttling setup:
Global Throttler (AppModule):
ttl: 60 (1 minute)
limit: 60 (60 requests per minute)
This is a general safety net.
ProductsController Throttling:
analyze endpoint: @Throttle({ default: { limit: 5, ttl: 60000 }}) (5 requests per minute)
generate-details endpoint: @Throttle({ default: { limit: 5, ttl: 60000 }}) (5 requests per minute)
shopify/locations: @Throttle({ default: { limit: 10, ttl: 60000 }}) (10 requests per minute)
shopify/inventory: @Throttle({ default: { limit: 10, ttl: 60000 }}) (10 requests per minute)
shopify/locations-with-products: @Throttle({ default: { limit: 10, ttl: 60000 }}) (10 requests per minute)
Other endpoints in ProductsController use the global default (60 reqs/min).
Will normal people be throttled?
For most actions, the 60 requests/minute global limit is quite generous for a single user. It's unlikely a normal user would hit this.
For the specific product analysis and Shopify endpoints, the limits are lower (5 or 10 per minute).
If a user is rapidly clicking a button that calls "analyze" five times within a minute, their sixth request in that minute would be throttled.
This is generally reasonable to prevent abuse or accidental repeated submissions. "10 times in less than 4 ms" would definitely be blocked, as it should be.
Considerations:
UserThrottlerGuard: You also have a UserThrottlerGuard which uses User ID or IP for rate limiting. This is good because it makes the limits per-user.
Frontend Experience: When a 429 (Too Many Requests) error occurs, your frontend should ideally handle this gracefully (e.g., disable the button for a short period, show a message "Please wait a moment before trying again").
Specific Endpoints: Review if 5 requests/minute for analyze or generate-details is appropriate for your user flow. If a user legitimately needs to do these actions more frequently, you might consider slightly increasing those specific limits or making the "per minute" window a bit longer (e.g., 10 requests per 2 minutes).
The QueueManager itself doesn't directly impact API request throttling. The API throttling happens before a job would even be enqueued by QueueManager.enqueueJob(). The queue system manages how background jobs are processed, not how incoming API requests are accepted.