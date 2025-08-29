# Real-time Sync System

This document describes the real-time webhook-based synchronization system that enables "magical" cross-platform inventory and product sync.

## Overview

The real-time sync system provides:
- **Bi-directional webhook processing** between sssync and external platforms (Shopify, Square, etc.)
- **Cross-platform propagation** of changes via event-driven architecture
- **Automatic webhook registration** when connections are created
- **Comprehensive error handling and logging** with activity tracking
- **Real-time inventory reconciliation** across all connected platforms

## Architecture

### Core Components

1. **WebhookController** (`webhook.controller.ts`)
   - Receives webhooks from external platforms
   - Handles security verification (HMAC validation)
   - Routes to appropriate platform adapters
   - Provides comprehensive logging and error handling

2. **SyncEventsService** (`sync-events.service.ts`)
   - Emits cross-platform sync events using EventEmitter
   - Decouples webhook processing from cross-platform sync logic
   - Defines standard event interfaces for products and inventory

3. **SyncEventListenersService** (`sync-event-listeners.service.ts`)
   - Listens for sync events and triggers cross-platform propagation
   - Determines which platforms should receive sync updates
   - Handles business logic for sync rule evaluation

4. **WebhookRegistrationService** (`webhook-registration.service.ts`)
   - Automatically registers required webhooks when connections are created
   - Manages webhook lifecycle (create, update, delete)
   - Platform-specific webhook management (currently Shopify)

5. **RealtimeSyncService** (`realtime-sync.service.ts`)
   - High-level service to enable/disable real-time sync for connections
   - Manages sync rules and webhook registration
   - Provides status monitoring and health checks

6. **Platform Adapters** (e.g., `shopify.adapter.ts`)
   - Process platform-specific webhook payloads
   - Handle product/inventory changes from webhooks
   - Emit appropriate cross-platform sync events

### Event Flow

```
External Platform → Webhook → WebhookController → Platform Adapter → SyncEventsService → SyncEventListenersService → Other Platform Adapters → External Platforms
```

## Webhook Endpoints

### Production Endpoints
- `POST /webhook/shopify/:connectionId` - Shopify webhooks
- `POST /webhook/square/:connectionId` - Square webhooks (future)
- `POST /webhook/clover/:connectionId` - Clover webhooks (future)

### Test Endpoints
- `POST /test/webhook/echo` - Echo webhook for testing
- `POST /test/webhook/shopify/:connectionId` - Test Shopify webhook processing
- `POST /test/webhook/generate/:platform/:topic` - Generate sample webhook payloads

## Supported Webhook Events

### Shopify
- `products/create` - New product created
- `products/update` - Product updated
- `products/delete` - Product deleted
- `inventory_levels/update` - Inventory quantity changed

### Future Platforms
- Square: `item.created`, `item.updated`, `inventory.count.updated`
- Clover: Similar product and inventory events
- eBay/Facebook/Whatnot: Webhooks and polling vary; initial implementation uses adapter stubs and will rely on job-based polling or partner APIs when enabled.

## Ingestion (CSV/Unstructured)

CSV imports are handled by a dedicated importer service (planned):
- Column mapping with auto-suggest
- Normalization for price/quantity/date
- Storage into `RawImportItems` (table planned) for subsequent matching
- Async matching job to produce `match_candidate` rows and suggestions

> Note: Embedding + reranker pipeline exists in products AI services and will be integrated for Step D matching.

## Real-time Sync Management

### Enable Real-time Sync
```typescript
POST /realtime-sync/enable/:connectionId
{
  "enableCrossPlatformSync": true,
  "propagateCreates": true,
  "propagateUpdates": true,
  "propagateDeletes": true,
  "propagateInventory": true
}
```

### Check Sync Status
```typescript
GET /realtime-sync/status/:connectionId
```

### Test Webhook Connectivity
```typescript
POST /realtime-sync/test/:connectionId
```

## Event Types

### Product Events
```typescript
interface ProductSyncEvent {
  type: 'PRODUCT_CREATED' | 'PRODUCT_UPDATED' | 'PRODUCT_DELETED';
  productId: string;
  userId: string;
  sourceConnectionId: string;
  sourcePlatform: string;
  platformProductId?: string;
  webhookId?: string;
}
```

### Inventory Events
```typescript
interface InventorySyncEvent {
  type: 'INVENTORY_UPDATED';
  variantId: string;
  userId: string;
  sourceConnectionId: string;
  sourcePlatform: string;
  locationId?: string;
  newQuantity?: number;
  webhookId?: string;
}
```

## Security

### Webhook Verification
- **Shopify**: HMAC-SHA256 verification using webhook secret
- **Square**: Signature verification (future implementation)
- **Rate limiting**: 100 requests per minute per connection
- **Request size limits**: 1MB max payload size

### Authentication
- All management endpoints require user authentication
- Webhook endpoints use platform-specific verification
- Connection ownership verification for all operations

## Error Handling

### Webhook Processing
- **Invalid signatures**: Rejected with 401 Unauthorized
- **Unknown topics**: Logged as warnings, return 200 OK
- **Processing errors**: Logged with full context, return 500
- **Connection not found**: Return 404 Not Found

### Cross-platform Sync
- **Failed propagation**: Logged and retried with exponential backoff
- **Platform unavailable**: Queued for later retry
- **Data conflicts**: Resolved based on sync rules and timestamp

### Activity Logging
All webhook and sync events are logged to the activity system:
- Webhook receipt and processing status
- Cross-platform sync initiation and results
- Error details and resolution attempts
- Performance metrics and timing

## Configuration

### Environment Variables
```bash
# Base URL for webhook endpoints
BASE_URL=https://your-domain.com

# Platform API credentials
SHOPIFY_API_KEY=your_shopify_api_key
SHOPIFY_API_SECRET=your_shopify_api_secret
SHOPIFY_WEBHOOK_SECRET=your_webhook_secret

# Redis for event system
REDIS_URL=redis://localhost:6379
```

### Sync Rules
Stored per connection in `PlatformConnections.SyncRules`:
```json
{
  "realtimeSyncEnabled": true,
  "propagateChanges": true,
  "propagateCreates": true,
  "propagateUpdates": true,
  "propagateDeletes": true,
  "propagateInventory": true
}
```

## Testing

### Manual Testing
1. Use the test endpoints to verify webhook reception
2. Generate sample payloads for different scenarios
3. Monitor logs for processing details

### Integration Testing
1. Create test products on connected platforms
2. Verify cross-platform propagation
3. Test inventory updates and reconciliation

### Load Testing
1. Simulate high-volume webhook traffic
2. Test rate limiting and error handling
3. Verify performance under load

## Monitoring

### Health Checks
- `GET /realtime-sync/health` - System health status
- Event system connectivity
- Webhook endpoint accessibility
- Recent activity monitoring

### Metrics to Monitor
- Webhook processing latency
- Cross-platform sync success rates
- Error rates by platform and event type
- Queue depths and processing times

## Future Enhancements

### Planned Features
1. **Conditional sync rules** - More granular control over what syncs
2. **Conflict resolution** - Advanced rules for handling data conflicts
3. **Batch operations** - Efficient handling of bulk changes
4. **Analytics dashboard** - Real-time sync monitoring and insights
5. **More platforms** - Square, Clover, WooCommerce, etc.

### Performance Optimizations
1. **Event batching** - Combine similar events for efficiency
2. **Smart routing** - Only sync to platforms that need updates
3. **Caching** - Reduce redundant API calls
4. **Parallel processing** - Concurrent cross-platform updates

## Troubleshooting

### Common Issues
1. **Webhooks not received**: Check webhook registration and URL accessibility
2. **Cross-platform sync failing**: Verify connection credentials and sync rules
3. **Performance issues**: Monitor queue depths and processing times
4. **Data inconsistencies**: Check conflict resolution logs and sync timestamps

### Debug Tools
1. Test webhook endpoints for manual verification
2. Activity logs for detailed event tracking
3. Health check endpoint for system status
4. Manual sync event triggers for testing 