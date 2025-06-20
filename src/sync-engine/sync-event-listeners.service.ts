import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { ProductSyncEvent, InventorySyncEvent } from './sync-events.service';
import { PlatformConnectionsService } from '../platform-connections/platform-connections.service';
import { ActivityLogService } from '../common/activity-log.service';

@Injectable()
export class SyncEventListenersService {
  private readonly logger = new Logger(SyncEventListenersService.name);

  constructor(
    private readonly syncCoordinator: SyncCoordinatorService,
    private readonly connectionsService: PlatformConnectionsService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  @OnEvent('product.sync')
  async handleProductSync(event: ProductSyncEvent): Promise<void> {
    const logPrefix = event.webhookId ? `[${event.webhookId}]` : '';
    this.logger.log(`${logPrefix} Handling product sync event: ${event.type} for product ${event.productId} from ${event.sourcePlatform}`);

    try {
      // Get all enabled connections for this user except the source connection
      const allConnections = await this.connectionsService.getConnectionsForUser(event.userId);
      const targetConnections = allConnections.filter(conn => 
        conn.IsEnabled && 
        conn.Id !== event.sourceConnectionId &&
        this.shouldPropagateToConnection(conn, event.type)
      );

      if (targetConnections.length === 0) {
        this.logger.debug(`${logPrefix} No target connections found for cross-platform sync of product ${event.productId}`);
        return;
      }

      this.logger.log(`${logPrefix} Triggering cross-platform sync to ${targetConnections.length} platforms for product ${event.productId}`);

      // Queue the appropriate sync operation based on event type
      switch (event.type) {
        case 'PRODUCT_CREATED':
          await this.syncCoordinator.handleCanonicalProductCreation(event.productId, event.userId);
          break;
        case 'PRODUCT_UPDATED':
          await this.syncCoordinator.handleCanonicalProductUpdate(event.productId, event.userId);
          break;
        case 'PRODUCT_DELETED':
          await this.syncCoordinator.handleCanonicalProductDeletion(event.productId, event.userId);
          break;
      }

      // Log successful cross-platform propagation
      await this.activityLogService.logActivity({
        UserId: event.userId,
        EntityType: 'Product',
        EntityId: event.productId,
        EventType: 'CROSS_PLATFORM_SYNC_TRIGGERED',
        Status: 'Success',
        Message: `${event.type} from ${event.sourcePlatform} triggered sync to ${targetConnections.length} other platforms`,
        Details: {
          sourceConnectionId: event.sourceConnectionId,
          sourcePlatform: event.sourcePlatform,
          targetPlatforms: targetConnections.map(c => c.PlatformType),
          webhookId: event.webhookId,
        }
      });

    } catch (error) {
      this.logger.error(`${logPrefix} Error handling product sync event for ${event.productId}: ${error.message}`, error.stack);
      
      // Log the error
      await this.activityLogService.logActivity({
        UserId: event.userId,
        EntityType: 'Product',
        EntityId: event.productId,
        EventType: 'CROSS_PLATFORM_SYNC_ERROR',
        Status: 'Error',
        Message: `Failed to trigger cross-platform sync: ${error.message}`,
        Details: {
          sourceConnectionId: event.sourceConnectionId,
          sourcePlatform: event.sourcePlatform,
          error: error.message,
          webhookId: event.webhookId,
        }
      });
    }
  }

  @OnEvent('inventory.sync')
  async handleInventorySync(event: InventorySyncEvent): Promise<void> {
    const logPrefix = event.webhookId ? `[${event.webhookId}]` : '';
    this.logger.log(`${logPrefix} Handling inventory sync event for variant ${event.variantId} from ${event.sourcePlatform}`);

    try {
      // Get all enabled connections for this user except the source connection
      const allConnections = await this.connectionsService.getConnectionsForUser(event.userId);
      const targetConnections = allConnections.filter(conn => 
        conn.IsEnabled && 
        conn.Id !== event.sourceConnectionId &&
        this.shouldPropagateInventoryToConnection(conn)
      );

      if (targetConnections.length === 0) {
        this.logger.debug(`${logPrefix} No target connections found for cross-platform inventory sync of variant ${event.variantId}`);
        return;
      }

      this.logger.log(`${logPrefix} Triggering cross-platform inventory sync to ${targetConnections.length} platforms for variant ${event.variantId}`);

      // Queue inventory update
      await this.syncCoordinator.handleCanonicalInventoryUpdate(event.variantId, event.userId);

      // Log successful cross-platform inventory propagation
      await this.activityLogService.logActivity({
        UserId: event.userId,
        EntityType: 'Inventory',
        EntityId: event.variantId,
        EventType: 'CROSS_PLATFORM_INVENTORY_SYNC_TRIGGERED',
        Status: 'Success',
        Message: `Inventory update from ${event.sourcePlatform} triggered sync to ${targetConnections.length} other platforms`,
        Details: {
          sourceConnectionId: event.sourceConnectionId,
          sourcePlatform: event.sourcePlatform,
          targetPlatforms: targetConnections.map(c => c.PlatformType),
          locationId: event.locationId,
          newQuantity: event.newQuantity,
          webhookId: event.webhookId,
        }
      });

    } catch (error) {
      this.logger.error(`${logPrefix} Error handling inventory sync event for ${event.variantId}: ${error.message}`, error.stack);
      
      // Log the error
      await this.activityLogService.logActivity({
        UserId: event.userId,
        EntityType: 'Inventory',
        EntityId: event.variantId,
        EventType: 'CROSS_PLATFORM_INVENTORY_SYNC_ERROR',
        Status: 'Error',
        Message: `Failed to trigger cross-platform inventory sync: ${error.message}`,
        Details: {
          sourceConnectionId: event.sourceConnectionId,
          sourcePlatform: event.sourcePlatform,
          error: error.message,
          webhookId: event.webhookId,
        }
      });
    }
  }

  @OnEvent('sync.success')
  async handleSyncSuccess(data: any): Promise<void> {
    // Log successful sync operations for monitoring
    this.logger.debug(`Sync success: ${data.type} for ${data.platform} (User: ${data.userId})`);
    
    // You could trigger notifications, analytics, etc. here
  }

  @OnEvent('sync.error')
  async handleSyncError(data: any): Promise<void> {
    // Log sync errors for monitoring and alerting
    this.logger.warn(`Sync error: ${data.type} for ${data.platform} (User: ${data.userId}) - ${data.error}`);
    
    // You could trigger notifications, alerts, etc. here
  }

  /**
   * Determine if changes should be propagated to a specific connection based on sync rules
   */
  private shouldPropagateToConnection(connection: any, eventType: string): boolean {
    const syncRules = connection.SyncRules || {};
    
    // Check global propagation setting
    if (syncRules.propagateChanges === false) {
      return false;
    }

    // Check specific event type settings
    switch (eventType) {
      case 'PRODUCT_CREATED':
        return syncRules.propagateCreates !== false; // Default to true
      case 'PRODUCT_UPDATED':
        return syncRules.propagateUpdates !== false; // Default to true
      case 'PRODUCT_DELETED':
        return syncRules.propagateDeletes !== false; // Default to true
      default:
        return true;
    }
  }

  /**
   * Determine if inventory changes should be propagated to a specific connection
   */
  private shouldPropagateInventoryToConnection(connection: any): boolean {
    const syncRules = connection.SyncRules || {};
    return syncRules.propagateInventory !== false; // Default to true
  }
} 