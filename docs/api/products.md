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