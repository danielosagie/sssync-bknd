# Shopify Product Management API

This document describes the comprehensive Shopify product management functionality, including read/update/delete/archive operations with full inventory tracking by account and location.

## Overview

The Shopify Product Management API provides:
- **Complete CRUD operations** for Shopify products
- **Location-based inventory management** with real-time tracking
- **Bulk operations** for managing multiple products efficiently
- **Advanced filtering and search** capabilities
- **Comprehensive activity logging** for audit trails
- **Real-time webhook integration** for automatic sync

## API Endpoints

### Product Operations

#### List Products
```
GET /shopify/{connectionId}/products
```

**Query Parameters:**
- `first` (number, optional): Number of products to fetch (max 250, default 50)
- `after` (string, optional): Pagination cursor for next page
- `status` (string, optional): Filter by status (`active`, `archived`, `draft`, `all`)
- `vendor` (string, optional): Filter by vendor name
- `productType` (string, optional): Filter by product type
- `title` (string, optional): Search in product titles
- `sku` (string, optional): Filter by SKU
- `tag` (string, optional): Filter by tag
- `createdAtMin` (string, optional): Filter by creation date (ISO 8601)
- `createdAtMax` (string, optional): Filter by creation date (ISO 8601)
- `updatedAtMin` (string, optional): Filter by update date (ISO 8601)
- `updatedAtMax` (string, optional): Filter by update date (ISO 8601)

**Response:**
```json
{
  "products": [
    {
      "id": "gid://shopify/Product/123456789",
      "title": "Amazing Product",
      "handle": "amazing-product",
      "status": "ACTIVE",
      "vendor": "My Brand",
      "productType": "Widget",
      "createdAt": "2024-01-01T00:00:00Z",
      "updatedAt": "2024-01-02T00:00:00Z",
      "publishedAt": "2024-01-01T12:00:00Z",
      "descriptionHtml": "<p>Product description</p>",
      "tags": ["featured", "sale"],
      "variants": [
        {
          "id": "gid://shopify/ProductVariant/987654321",
          "title": "Default Title",
          "price": "29.99",
          "compareAtPrice": "39.99",
          "sku": "WIDGET-001",
          "barcode": "123456789012",
          "inventoryQuantity": 100,
          "inventoryItem": {
            "id": "gid://shopify/InventoryItem/555666777",
            "tracked": true
          },
          "position": 1,
          "availableForSale": true,
          "inventory": [
            {
              "locationId": "gid://shopify/Location/111222333",
              "locationName": "Main Warehouse",
              "available": 50,
              "isActive": true
            },
            {
              "locationId": "gid://shopify/Location/444555666",
              "locationName": "Retail Store",
              "available": 50,
              "isActive": true
            }
          ]
        }
      ],
      "media": [
        {
          "id": "gid://shopify/MediaImage/789123456",
          "mediaContentType": "IMAGE",
          "image": {
            "url": "https://cdn.shopify.com/image.jpg",
            "altText": "Product image"
          }
        }
      ],
      "totalInventoryValue": 2999.00,
      "locations": [
        {
          "locationId": "gid://shopify/Location/111222333",
          "locationName": "Main Warehouse",
          "available": 50,
          "isActive": true
        }
      ]
    }
  ],
  "pageInfo": {
    "hasNextPage": true,
    "endCursor": "eyJsYXN0X2lkIjo..."
  },
  "totalCount": 1234
}
```

#### Get Single Product
```
GET /shopify/{connectionId}/products/{productId}
```

Returns detailed product information with complete inventory data across all locations.

#### Update Product
```
PUT /shopify/{connectionId}/products/{productId}
```

**Request Body:**
```json
{
  "title": "Updated Product Title",
  "handle": "updated-product-handle",
  "descriptionHtml": "<p>Updated description</p>",
  "vendor": "Updated Vendor",
  "productType": "Updated Type",
  "tags": ["updated", "tags"],
  "status": "ACTIVE"
}
```

#### Archive Product (Soft Delete)
```
POST /shopify/{connectionId}/products/{productId}/archive
```

Sets product status to `ARCHIVED`, making it unavailable for sale but preserving all data.

#### Unarchive Product (Restore)
```
POST /shopify/{connectionId}/products/{productId}/unarchive
```

Restores an archived product by setting status to `ACTIVE`.

#### Delete Product (Permanent)
```
DELETE /shopify/{connectionId}/products/{productId}
```

Permanently deletes the product and all associated data from Shopify.

### Inventory Operations

#### Update Product Inventory
```
PUT /shopify/{connectionId}/products/{productId}/inventory
```

**Request Body:**
```json
{
  "updates": [
    {
      "variantId": "gid://shopify/ProductVariant/987654321",
      "inventoryItemId": "gid://shopify/InventoryItem/555666777",
      "locationId": "gid://shopify/Location/111222333",
      "quantity": 75
    }
  ],
  "reason": "Inventory adjustment from sssync"
}
```

### Location Management

#### Get Locations
```
GET /shopify/{connectionId}/products/_/locations?includeInactive=false
```

Returns all locations available for inventory management.

### Batch Operations

#### Archive Multiple Products
```
POST /shopify/{connectionId}/products/_/archive
```

**Request Body:**
```json
{
  "productIds": [
    "gid://shopify/Product/123456789",
    "gid://shopify/Product/987654321"
  ]
}
```

**Response:**
```json
{
  "successful": 2,
  "failed": 0,
  "results": {
    "successful": [
      {
        "productId": "gid://shopify/Product/123456789",
        "product": { /* product data */ }
      }
    ],
    "failed": []
  }
}
```

#### Delete Multiple Products
```
DELETE /shopify/{connectionId}/products/_/batch
```

#### Update Multiple Product Status
```
PUT /shopify/{connectionId}/products/_/status
```

**Request Body:**
```json
{
  "productIds": [
    "gid://shopify/Product/123456789",
    "gid://shopify/Product/987654321"
  ],
  "status": "ARCHIVED"
}
```

## GraphQL Queries and Mutations

The system uses optimized GraphQL queries for efficient data retrieval:

### Enhanced Product Query
```graphql
query getProduct($id: ID!) {
  product(id: $id) {
    id
    title
    handle
    status
    vendor
    productType
    createdAt
    updatedAt
    publishedAt
    descriptionHtml
    tags
    variants(first: 100) {
      edges {
        node {
          id
          title
          price
          compareAtPrice
          sku
          barcode
          inventoryQuantity
          inventoryItem {
            id
            tracked
          }
          position
          availableForSale
        }
      }
    }
    media(first: 20) {
      edges {
        node {
          id
          mediaContentType
          ... on MediaImage {
            image {
              url
              altText
            }
          }
        }
      }
    }
  }
}
```

### Inventory Management Mutations
```graphql
mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
  inventorySetQuantities(input: $input) {
    inventoryAdjustmentGroup {
      id
      createdAt
      reason
      referenceDocumentUri
      changes {
        name
        delta
        quantityAfterChange
        item {
          id
        }
        location {
          id
          name
        }
      }
    }
    userErrors {
      field
      message
      code
    }
  }
}
```

## Service Architecture

### ShopifyProductManagerService
High-level service providing business logic for product management:
- Product CRUD operations with validation
- Inventory management with location tracking
- Activity logging and audit trails
- Error handling and user feedback

### ShopifyApiClient (Enhanced)
Low-level GraphQL client with new methods:
- `getProductById()` - Get single product with full details
- `getProductsWithFilters()` - Advanced product filtering
- `updateProductDetails()` - Update product metadata
- `archiveProduct()` / `unarchiveProduct()` - Status management
- `deleteProductPermanently()` - Permanent deletion
- `setInventoryQuantities()` - Absolute inventory updates
- `adjustInventoryQuantities()` - Relative inventory adjustments
- `getLocationsDetailed()` - Location information
- `getInventoryLevelsForItems()` - Multi-location inventory data

### ShopifyProductsController
REST API controller exposing all operations with:
- Authentication and authorization
- Connection validation
- Request/response validation
- Batch operation support
- Error handling and standardized responses

## Features

### Advanced Filtering
- **Status filtering**: active, archived, draft, or all products
- **Metadata filtering**: vendor, product type, tags
- **Text search**: title and SKU search with wildcards
- **Date range filtering**: creation and update date ranges
- **Combination filters**: Multiple filters can be combined

### Location-Based Inventory
- **Multi-location tracking**: Inventory tracked per location
- **Real-time quantities**: Current available quantities
- **Location metadata**: Location names, addresses, status
- **Inventory value calculation**: Total value across all locations

### Batch Operations
- **Bulk archiving**: Archive multiple products in one request
- **Bulk deletion**: Delete multiple products efficiently
- **Bulk status updates**: Change status for multiple products
- **Partial success handling**: Continue processing if some operations fail

### Activity Logging
All operations are automatically logged with:
- User identification
- Operation type and details
- Timestamps and durations
- Success/failure status
- Product and inventory details

### Error Handling
- **Shopify API error mapping**: Convert Shopify errors to user-friendly messages
- **Validation errors**: Handle invalid inputs gracefully
- **Connection errors**: Detect and report connectivity issues
- **Partial failure reporting**: Report which operations succeeded/failed in batch operations

## Real-time Integration

### Webhook Support
The product management system integrates with the real-time webhook system:
- **Product changes**: Automatic sync when products are modified
- **Inventory updates**: Real-time inventory sync across platforms
- **Status changes**: Archive/unarchive operations trigger webhooks
- **Cross-platform sync**: Changes propagate to other connected platforms

### Event Emission
Product operations emit events for:
- Cross-platform synchronization
- Activity logging
- Analytics and reporting
- Custom business logic integration

## Security

### Authentication
- All endpoints require valid user authentication
- JWT-based authentication with role validation

### Authorization
- Connection ownership verification
- User access to specific Shopify stores only
- Platform-specific permission checking

### Data Validation
- Input sanitization and validation
- GraphQL query parameter validation
- Business rule enforcement (e.g., handle uniqueness)

## Performance Optimizations

### Efficient Queries
- **Pagination support**: Cursor-based pagination for large datasets
- **Field selection**: Only fetch required data
- **Batch loading**: Combine multiple operations where possible

### Caching Strategy
- **Connection caching**: Cache validated connections
- **Location caching**: Cache location data for inventory operations
- **Query result caching**: Cache frequently accessed data

### Rate Limiting
- **Shopify API limits**: Respect Shopify's GraphQL query cost limits
- **Request throttling**: Prevent API abuse
- **Batch size limits**: Limit batch operations to reasonable sizes

## Error Scenarios and Handling

### Common Errors
1. **Product not found**: Returns 404 with clear message
2. **Invalid product status**: Validates status values
3. **Handle conflicts**: Checks handle availability before updates
4. **Inventory item not found**: Validates inventory item IDs
5. **Location not found**: Validates location IDs for inventory updates
6. **Connection disabled**: Prevents operations on disabled connections

### Recovery Strategies
1. **Retry logic**: Automatic retry for transient errors
2. **Partial success**: Continue batch operations despite individual failures
3. **Rollback support**: Undo operations where possible
4. **Error reporting**: Detailed error messages for debugging

## Usage Examples

### Get Active Products for a Store
```bash
curl -X GET "https://api.sssync.com/shopify/conn_123/products?status=active&first=10" \
  -H "Authorization: Bearer {token}"
```

### Archive Products by Vendor
```bash
# First, get products by vendor
curl -X GET "https://api.sssync.com/shopify/conn_123/products?vendor=Old%20Brand" \
  -H "Authorization: Bearer {token}"

# Then archive them
curl -X POST "https://api.sssync.com/shopify/conn_123/products/_/archive" \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{"productIds": ["gid://shopify/Product/123", "gid://shopify/Product/456"]}'
```

### Update Inventory Across Locations
```bash
curl -X PUT "https://api.sssync.com/shopify/conn_123/products/gid%3A%2F%2Fshopify%2FProduct%2F123/inventory" \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{
    "updates": [
      {
        "variantId": "gid://shopify/ProductVariant/456",
        "inventoryItemId": "gid://shopify/InventoryItem/789",
        "locationId": "gid://shopify/Location/111",
        "quantity": 50
      }
    ],
    "reason": "Restock from supplier"
  }'
```

### Search Products by Title and Tag
```bash
curl -X GET "https://api.sssync.com/shopify/conn_123/products?title=shirt&tag=summer&status=active" \
  -H "Authorization: Bearer {token}"
```

This comprehensive product management system provides all the tools needed for efficient Shopify product and inventory management within the sssync platform, with full integration into the real-time sync and webhook systems. 