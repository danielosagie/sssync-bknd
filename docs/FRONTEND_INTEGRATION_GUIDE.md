# Frontend Integration Guide

## Overview

This guide covers the integration patterns for SSSync's bi-directional inventory sync system, including OAuth flows, import processes, and job management.

## Table of Contents

1. [OAuth Flows](#oauth-flows)
2. [Import Flows](#import-flows)
3. [Job System](#job-system)
4. [API Endpoints Reference](#api-endpoints-reference)
5. [Error Handling](#error-handling)
6. [Best Practices](#best-practices)

---

## OAuth Flows

### Platform Connection Flow

All platform connections follow a similar OAuth 2.0 pattern with platform-specific variations.

#### 1. Initiate Connection

**Endpoint:** `GET /api/auth/{platform}/login`

**Query Parameters:**
- `userId`: SSSync user ID
- `finalRedirectUri`: App-specific deep link (e.g., `sssyncapp://auth-callback?platform=shopify`)

**Example Request:**
```javascript
const initiateConnection = async (platform, userId) => {
  const finalRedirectUri = `sssyncapp://auth-callback?platform=${platform}`;
  const url = `${API_BASE}/api/auth/${platform}/login?userId=${userId}&finalRedirectUri=${encodeURIComponent(finalRedirectUri)}`;
  
  // Open in WebBrowser for OAuth flow
  const result = await WebBrowser.openAuthSessionAsync(url, finalRedirectUri);
  
  if (result.type === 'success') {
    // Parse callback URL for status and connectionId
    const urlParams = new URLSearchParams(result.url.split('?')[1]);
    const status = urlParams.get('status');
    const connectionId = urlParams.get('connectionId');
    
    if (status === 'success' && connectionId) {
      // Proceed to start initial scan
      await startPlatformScan(connectionId, platform);
    }
  }
};
```

#### 2. Platform-Specific OAuth Endpoints

| Platform | Endpoint | Special Notes |
|----------|----------|---------------|
| Shopify | `/api/auth/shopify/login` | Supports shop name extraction from URL |
| Square | `/api/auth/square/login` | Standard OAuth flow |
| Clover | `/api/auth/clover/login` | Standard OAuth flow |
| eBay | `/api/auth/ebay/login` | Standard OAuth flow |
| Facebook | `/api/auth/facebook/login` | Standard OAuth flow |

#### 3. Shopify Special Flow

Shopify has an enhanced flow that supports both guided URL copying and direct shop name entry:

```javascript
// Guided Shopify Flow
const connectShopify = async (shopifyUrl, userId) => {
  // Extract shop name from admin URL
  const shopNameRegex = /admin\.shopify\.com\/store\/([a-zA-Z0-9\-]+)/;
  const match = shopifyUrl.match(shopNameRegex);
  
  if (match && match[1]) {
    const shopName = match[1];
    const finalRedirectUri = 'sssyncapp://auth-callback';
    const url = `${API_BASE}/api/auth/shopify/login?userId=${userId}&shop=${shopName}&finalRedirectUri=${encodeURIComponent(finalRedirectUri)}`;
    
    const result = await WebBrowser.openAuthSessionAsync(url, finalRedirectUri);
    // Handle result...
  }
};
```

---

## Import Flows

### 1. Platform Import (OAuth-based)

After successful OAuth connection, initiate the import process:

**Endpoint:** `POST /api/sync/connections/{connectionId}/start-scan`

**Request Body:**
```javascript
{
  // Optional: Override default scan settings
  "scanOptions": {
    "includeArchived": false,
    "maxProducts": 1000,
    "syncInventory": true
  }
}
```

**Response:**
```javascript
{
  "jobId": "uuid-string",
  "status": "queued",
  "message": "Import job queued successfully",
  "estimatedTimeMinutes": 5,
  "totalProducts": 0 // Will be updated as scan progresses
}
```

### 2. CSV Import

**Endpoint:** `POST /api/ingest/csv`

**Request Body (multipart/form-data):**
```javascript
const formData = new FormData();
formData.append('file', csvFile);
formData.append('platformType', 'shopify'); // Target platform
formData.append('mappingConfig', JSON.stringify({
  // Column mappings
  "title": "Product Name",
  "sku": "SKU",
  "price": "Price",
  "description": "Description",
  "category": "Category"
}));
formData.append('importOptions', JSON.stringify({
  "createNewProducts": true,
  "updateExisting": false,
  "validateData": true
}));
```

**Response:**
```javascript
{
  "jobId": "uuid-string",
  "status": "queued",
  "totalRows": 150,
  "estimatedTimeMinutes": 2
}
```

### 3. Import Job Monitoring

**Endpoint:** `GET /api/sync/jobs/{jobId}/progress`

**Response:**
```javascript
{
  "jobId": "uuid-string",
  "status": "processing", // queued, processing, completed, failed
  "currentStage": "mapping_products", // scanning, mapping, syncing
  "progress": {
    "totalProducts": 150,
    "processedProducts": 45,
    "failedProducts": 2,
    "stagePercentage": 30
  },
  "estimatedCompletionAt": "2025-01-15T10:30:00Z",
  "lastUpdated": "2025-01-15T10:15:00Z"
}
```

---

## Job System

### Job Types

The system uses BullMQ for job processing with different queue types:

1. **Initial Scan Jobs** (`initial-scan` queue)
2. **Backfill Jobs** (`backfill-jobs` queue)
3. **Export Jobs** (`export-jobs` queue)
4. **Product Analysis Jobs** (`product-analysis` queue)
5. **Match Jobs** (`match-jobs` queue)
6. **Generate Jobs** (`generate-jobs` queue)

### Job Status Tracking

All jobs follow a consistent status pattern:

```javascript
const JOB_STATUSES = {
  QUEUED: 'queued',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
};
```

### Job Progress Monitoring

**Generic Job Progress Endpoint:** `GET /api/products/jobs/{jobId}/status`

**Response:**
```javascript
{
  "jobId": "uuid-string",
  "status": "processing",
  "currentStage": "analyzing_products",
  "progress": {
    "total": 100,
    "completed": 45,
    "failed": 2,
    "percentage": 45
  },
  "estimatedCompletionAt": "2025-01-15T10:30:00Z",
  "startedAt": "2025-01-15T10:00:00Z",
  "lastUpdated": "2025-01-15T10:15:00Z"
}
```

### Job Cancellation

**Endpoint:** `DELETE /api/products/jobs/{jobId}`

**Response:**
```javascript
{
  "jobId": "uuid-string",
  "status": "cancelled",
  "message": "Job cancelled successfully"
}
```

---

## API Endpoints Reference

### Authentication

All API calls require Bearer token authentication:

```javascript
const headers = {
  'Authorization': `Bearer ${accessToken}`,
  'Content-Type': 'application/json'
};
```

### Platform Connections

#### Get User Connections
```javascript
GET /api/platform-connections
Headers: { Authorization: Bearer <token> }

Response:
{
  "connections": [
    {
      "Id": "uuid",
      "PlatformType": "shopify",
      "DisplayName": "My Shopify Store",
      "Status": "active",
      "IsEnabled": true,
      "LastSyncSuccessAt": "2025-01-15T10:00:00Z",
      "CreatedAt": "2025-01-15T09:00:00Z"
    }
  ]
}
```

#### Update Connection Status
```javascript
PATCH /api/platform-connections/{connectionId}/status
Body: { "status": "active" | "inactive" }
```

#### Delete Connection
```javascript
DELETE /api/platform-connections/{connectionId}
```

### Product Management

#### Create Product
```javascript
POST /api/products
Body: {
  "userId": "user-uuid",
  "variantData": {
    "Title": "Product Name",
    "Description": "Product description",
    "Price": 29.99,
    "Sku": "SKU123",
    "Barcode": "1234567890123",
    "Weight": 0.5,
    "WeightUnit": "POUNDS"
  }
}
```

#### Publish to Platform
```javascript
POST /api/products/{productId}/publish/{platform}
Body: {
  "platformConnectionId": "connection-uuid",
  "locations": [
    { "locationId": "loc-1", "quantity": 10 }
  ],
  "options": {
    "status": "ACTIVE",
    "vendor": "My Brand",
    "tags": ["tag1", "tag2"]
  }
}
```

### Backfill System

#### Analyze Data Gaps
```javascript
GET /api/backfill/analyze/{connectionId}?userId={userId}

Response:
{
  "success": true,
  "data": {
    "connectionId": "uuid",
    "platformType": "shopify",
    "totalProducts": 150,
    "gaps": {
      "missingPhotos": 23,
      "missingDescriptions": 45,
      "missingTags": 67,
      "missingBarcodes": 89,
      "missingPricing": 12,
      "missingInventory": 34
    },
    "recommendations": [
      {
        "priority": "high",
        "action": "Generate missing descriptions",
        "estimatedCost": 15.50,
        "estimatedTime": "30 minutes"
      }
    ]
  }
}
```

#### Create Backfill Job
```javascript
POST /api/backfill/jobs
Body: {
  "connectionId": "uuid",
  "jobType": "bulk_ai_backfill",
  "dataTypes": ["description", "tags"],
  "priority": "medium",
  "userPreferences": {
    "tone": "professional",
    "includeSpecifications": true
  }
}
```

#### Monitor Backfill Progress
```javascript
GET /api/backfill/jobs/{jobId}?userId={userId}

Response:
{
  "success": true,
  "data": {
    "Id": "job-uuid",
    "JobType": "bulk_ai_backfill",
    "Status": "processing",
    "Progress": 65,
    "TotalItems": 100,
    "ProcessedItems": 65,
    "FailedItems": 2,
    "StartedAt": "2025-01-15T10:00:00Z",
    "EstimatedCompletionAt": "2025-01-15T10:30:00Z"
  }
}
```

---

## Error Handling

### Standard Error Response Format

```javascript
{
  "success": false,
  "error": "Error message",
  "code": "ERROR_CODE",
  "details": {
    "field": "additional error context"
  }
}
```

### Common Error Codes

| Code | Description | Action |
|------|-------------|--------|
| `AUTH_REQUIRED` | Authentication token missing/invalid | Re-authenticate user |
| `CONNECTION_NOT_FOUND` | Platform connection doesn't exist | Check connection status |
| `JOB_NOT_FOUND` | Job ID doesn't exist | Verify job ID |
| `RATE_LIMIT_EXCEEDED` | API rate limit hit | Implement exponential backoff |
| `PLATFORM_API_ERROR` | External platform API error | Retry with delay |
| `VALIDATION_ERROR` | Request data validation failed | Check request format |

### Error Handling Example

```javascript
const handleApiError = async (response) => {
  if (!response.ok) {
    const errorData = await response.json();
    
    switch (errorData.code) {
      case 'AUTH_REQUIRED':
        await refreshAuthToken();
        return retryRequest();
        
      case 'RATE_LIMIT_EXCEEDED':
        await delay(1000 * Math.pow(2, retryCount));
        return retryRequest();
        
      case 'CONNECTION_NOT_FOUND':
        showConnectionError();
        break;
        
      default:
        showGenericError(errorData.error);
    }
  }
};
```

---

## Best Practices

### 1. Job Polling

Implement exponential backoff for job status polling:

```javascript
const pollJobStatus = async (jobId, maxAttempts = 30) => {
  let attempt = 0;
  const baseDelay = 1000; // 1 second
  
  while (attempt < maxAttempts) {
    const status = await getJobStatus(jobId);
    
    if (status.status === 'completed' || status.status === 'failed') {
      return status;
    }
    
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s, 30s...
    const delay = Math.min(baseDelay * Math.pow(2, attempt), 30000);
    await new Promise(resolve => setTimeout(resolve, delay));
    attempt++;
  }
  
  throw new Error('Job polling timeout');
};
```

### 2. Connection State Management

Maintain connection state in your app:

```javascript
const CONNECTION_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  PENDING: 'pending',
  NEEDS_REVIEW: 'needs_review',
  SCANNING: 'scanning',
  ERROR: 'error',
  SYNCING: 'syncing',
  RECONCILING: 'reconciling'
};

const getConnectionActions = (status) => {
  switch (status) {
    case CONNECTION_STATUS.PENDING:
      return ['Complete Setup'];
    case CONNECTION_STATUS.NEEDS_REVIEW:
      return ['Review & Sync'];
    case CONNECTION_STATUS.ERROR:
      return ['Fix & Resume'];
    case CONNECTION_STATUS.ACTIVE:
      return ['Manage', 'Reconcile'];
    default:
      return [];
  }
};
```

### 3. Real-time Updates

Use Supabase real-time subscriptions for connection status updates:

```javascript
const setupConnectionSubscription = (userId) => {
  const channel = supabase
    .channel('platform-connections')
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'PlatformConnections',
      filter: `UserId=eq.${userId}`
    }, (payload) => {
      // Update local connection state
      updateConnectionStatus(payload.new);
      
      // Show notification for status changes
      if (payload.old.Status !== payload.new.Status) {
        showStatusNotification(payload.new);
      }
    })
    .subscribe();
    
  return channel;
};
```

### 4. File Upload Handling

For CSV imports, implement proper file validation:

```javascript
const validateCsvFile = (file) => {
  const maxSize = 10 * 1024 * 1024; // 10MB
  const allowedTypes = ['text/csv', 'application/csv'];
  
  if (file.size > maxSize) {
    throw new Error('File too large. Maximum size is 10MB.');
  }
  
  if (!allowedTypes.includes(file.type)) {
    throw new Error('Invalid file type. Please upload a CSV file.');
  }
  
  return true;
};
```

### 5. Offline Handling

Implement offline queue for critical operations:

```javascript
const queueOfflineAction = (action) => {
  const offlineQueue = JSON.parse(localStorage.getItem('offlineQueue') || '[]');
  offlineQueue.push({
    id: Date.now(),
    action,
    timestamp: new Date().toISOString()
  });
  localStorage.setItem('offlineQueue', JSON.stringify(offlineQueue));
};

const processOfflineQueue = async () => {
  const offlineQueue = JSON.parse(localStorage.getItem('offlineQueue') || '[]');
  
  for (const item of offlineQueue) {
    try {
      await executeAction(item.action);
      // Remove successful item
      const updatedQueue = offlineQueue.filter(q => q.id !== item.id);
      localStorage.setItem('offlineQueue', JSON.stringify(updatedQueue));
    } catch (error) {
      console.error('Failed to process offline action:', error);
    }
  }
};
```

---

## Testing

### Mock Responses

Create mock responses for development:

```javascript
const mockJobResponse = {
  jobId: 'mock-job-uuid',
  status: 'queued',
  estimatedTimeMinutes: 5,
  totalProducts: 100
};

const mockConnectionResponse = {
  connections: [
    {
      Id: 'mock-connection-uuid',
      PlatformType: 'shopify',
      DisplayName: 'Test Store',
      Status: 'active',
      IsEnabled: true
    }
  ]
};
```

### Environment Configuration

```javascript
const config = {
  development: {
    apiBase: 'http://localhost:3000/api',
    enableMocking: true
  },
  staging: {
    apiBase: 'https://staging-api.sssync.app/api',
    enableMocking: false
  },
  production: {
    apiBase: 'https://api.sssync.app/api',
    enableMocking: false
  }
};
```

This documentation provides a comprehensive guide for frontend engineers to integrate with SSSync's backend services. For additional questions or clarifications, refer to the API documentation or contact the backend team.












