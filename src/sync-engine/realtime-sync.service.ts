import { Injectable, Logger } from '@nestjs/common';
import { WebhookRegistrationService } from './webhook-registration.service';
import { SyncEventsService } from './sync-events.service';
import { PlatformConnection, PlatformConnectionsService } from '../platform-connections/platform-connections.service';
import { ShopifyApiClient } from '../platform-adapters/shopify/shopify-api-client.service';
import { PlatformAdapterRegistry } from '../platform-adapters/adapter.registry';
import { ActivityLogService } from '../common/activity-log.service';

export interface RealtimeSyncStatus {
  connectionId: string;
  platform: string;
  webhooksRegistered: boolean;
  webhookCount: number;
  crossPlatformSyncEnabled: boolean;
  lastWebhookReceived?: string;
  errors: string[];
}

@Injectable()
export class RealtimeSyncService {
  private readonly logger = new Logger(RealtimeSyncService.name);

  constructor(
    private readonly webhookRegistrationService: WebhookRegistrationService,
    private readonly syncEventsService: SyncEventsService,
    private readonly connectionsService: PlatformConnectionsService,
    private readonly adapterRegistry: PlatformAdapterRegistry,
    private readonly activityLogService: ActivityLogService,
  ) {}

  /**
   * Enable real-time sync for a platform connection
   * This sets up webhooks and configures sync rules
   */
  async enableRealtimeSync(connectionId: string, options?: {
    enableCrossPlatformSync?: boolean;
    propagateCreates?: boolean;
    propagateUpdates?: boolean;
    propagateDeletes?: boolean;
    propagateInventory?: boolean;
  }): Promise<RealtimeSyncStatus> {
    this.logger.log(`Enabling real-time sync for connection ${connectionId}`);

    const connection = await this.connectionsService.getConnectionById(connectionId);
    if (!connection) {
      throw new Error(`Connection ${connectionId} not found`);
    }

    const status: RealtimeSyncStatus = {
      connectionId,
      platform: connection.PlatformType,
      webhooksRegistered: false,
      webhookCount: 0,
      crossPlatformSyncEnabled: options?.enableCrossPlatformSync !== false,
      errors: [],
    };

    try {
      // Update sync rules on the connection
      const syncRules = {
        propagateChanges: options?.enableCrossPlatformSync !== false,
        propagateCreates: options?.propagateCreates !== false,
        propagateUpdates: options?.propagateUpdates !== false,
        propagateDeletes: options?.propagateDeletes !== false,
        propagateInventory: options?.propagateInventory !== false,
        realtimeSyncEnabled: true,
      };

      await this.connectionsService.updateConnectionSyncRules(connectionId, syncRules);

      // Register webhooks based on platform type
      if (connection.PlatformType === 'shopify') {
        const result = await this.enableShopifyRealtimeSync(connection);
        status.webhooksRegistered = result.success;
        status.webhookCount = result.webhooks.filter(w => !w.error).length;
        status.errors = result.webhooks.filter(w => w.error).map(w => w.error!);
      } else {
        status.errors.push(`Real-time sync not yet supported for platform: ${connection.PlatformType}`);
      }

      // Log the enablement
      await this.activityLogService.logActivity({
        UserId: connection.UserId,
        EntityType: 'Connection',
        EntityId: connectionId,
        EventType: 'REALTIME_SYNC_ENABLED',
        Status: 'Success',
        Message: `Real-time sync enabled for ${connection.PlatformType} connection.`,
        PlatformConnectionId: connectionId,
        Details: {
          platform: connection.PlatformType,
          webhooksRegistered: status.webhooksRegistered,
          webhookCount: status.webhookCount,
          errors: status.errors,
        }
      });

      this.logger.log(`Real-time sync ${status.webhooksRegistered ? 'successfully enabled' : 'enabled with warnings'} for connection ${connectionId}`);

    } catch (error) {
      status.errors.push(error.message);
      this.logger.error(`Failed to enable real-time sync for connection ${connectionId}: ${error.message}`, error.stack);
      
      await this.activityLogService.logActivity({
        UserId: connection.UserId,
        EntityType: 'Connection',
        EntityId: connectionId,
        EventType: 'REALTIME_SYNC_ENABLE_FAILED',
        Status: 'Error',
        Message: `Failed to enable real-time sync for ${connection.PlatformType}: ${error.message}`,
        Details: { error: error.message }
      });
    }

    return status;
  }

  /**
   * Disable real-time sync for a platform connection
   */
  async disableRealtimeSync(connectionId: string): Promise<boolean> {
    this.logger.log(`Disabling real-time sync for connection ${connectionId}`);

    const connection = await this.connectionsService.getConnectionById(connectionId);
    if (!connection) {
      throw new Error(`Connection ${connectionId} not found`);
    }

    try {
      // Update sync rules to disable real-time sync
      const syncRules = {
        ...connection.SyncRules,
        realtimeSyncEnabled: false,
      };

      await this.connectionsService.updateConnectionSyncRules(connectionId, syncRules);

      // Unregister webhooks based on platform type
      let unregistered = false;
      if (connection.PlatformType === 'shopify') {
        unregistered = await this.disableShopifyRealtimeSync(connection);
      }

      // Log the disablement
      await this.activityLogService.logActivity({
        UserId: connection.UserId,
        EntityType: 'Connection',
        EntityId: connectionId,
        EventType: 'REALTIME_SYNC_DISABLED',
        Status: 'Success',
        Message: `Real-time sync disabled for ${connection.PlatformType} connection.`,
        PlatformConnectionId: connectionId,
        Details: {
          webhooksUnregistered: unregistered
        }
      });

      this.logger.log(`Real-time sync disabled for connection ${connectionId}`);
      return unregistered;

    } catch (error) {
      this.logger.error(`Failed to disable real-time sync for connection ${connectionId}: ${error.message}`, error.stack);
      
      await this.activityLogService.logActivity({
        UserId: connection.UserId,
        EntityType: 'Connection',
        EntityId: connectionId,
        EventType: 'REALTIME_SYNC_DISABLE_FAILED',
        Status: 'Error',
        Message: `Failed to disable real-time sync for ${connection.PlatformType}: ${error.message}`,
        Details: { error: error.message }
      });
      
      return false;
    }
  }

  /**
   * Get the real-time sync status for a connection
   */
  async getRealtimeSyncStatus(connectionId: string): Promise<RealtimeSyncStatus> {
    const connection = await this.connectionsService.getConnectionById(connectionId);
    if (!connection) {
      throw new Error(`Connection ${connectionId} not found`);
    }

    const syncRules = connection.SyncRules || {};
    
    const status: RealtimeSyncStatus = {
      connectionId,
      platform: connection.PlatformType,
      webhooksRegistered: syncRules.realtimeSyncEnabled === true,
      webhookCount: 0,
      crossPlatformSyncEnabled: syncRules.propagateChanges !== false,
      errors: [],
    };

    // TODO: Query actual webhook status from platform
    // For now, we rely on our stored sync rules

    return status;
  }

  /**
   * Get real-time sync status for all connections of a user
   */
  async getUserRealtimeSyncStatus(userId: string): Promise<RealtimeSyncStatus[]> {
    const connections = await this.connectionsService.getConnectionsForUser(userId);
    const statusPromises = connections.map(conn => this.getRealtimeSyncStatus(conn.Id));
    return Promise.all(statusPromises);
  }

  /**
   * Test webhook connectivity for a connection
   */
  async testWebhookConnectivity(connectionId: string): Promise<{
    success: boolean;
    message: string;
    details?: any;
  }> {
    this.logger.log(`Testing webhook connectivity for connection ${connectionId}`);

    // TODO: Implement webhook connectivity test
    // This could involve:
    // 1. Creating a test product/variant
    // 2. Updating it to trigger a webhook
    // 3. Monitoring for webhook receipt
    // 4. Cleaning up the test data

    return {
      success: true,
      message: 'Webhook connectivity test not yet implemented',
    };
  }

  private async enableShopifyRealtimeSync(connection: PlatformConnection): Promise<any> {
    const adapter = this.adapterRegistry.getAdapter('shopify');
    if (!adapter) {
      throw new Error('Shopify adapter not found');
    }

    // Get Shopify API client
    const shopifyApiClient = adapter.getApiClient(connection) as ShopifyApiClient;
    
    // Register webhooks
    return this.webhookRegistrationService.registerShopifyWebhooks(connection, shopifyApiClient);
  }

  private async disableShopifyRealtimeSync(connection: PlatformConnection): Promise<boolean> {
    const adapter = this.adapterRegistry.getAdapter('shopify');
    if (!adapter) {
      throw new Error('Shopify adapter not found');
    }

    // Get Shopify API client
    const shopifyApiClient = adapter.getApiClient(connection) as ShopifyApiClient;
    
    // Unregister webhooks
    return this.webhookRegistrationService.unregisterShopifyWebhooks(connection, shopifyApiClient);
  }

  /**
   * Manually trigger a cross-platform sync event (for testing)
   */
  async triggerManualSyncEvent(
    type: 'PRODUCT_CREATED' | 'PRODUCT_UPDATED' | 'PRODUCT_DELETED' | 'INVENTORY_UPDATED',
    entityId: string,
    sourceConnectionId: string
  ): Promise<void> {
    const connection = await this.connectionsService.getConnectionById(sourceConnectionId);
    if (!connection) {
      throw new Error(`Connection ${sourceConnectionId} not found`);
    }

    this.logger.log(`Manually triggering ${type} sync event for entity ${entityId} from connection ${sourceConnectionId}`);

    if (type === 'INVENTORY_UPDATED') {
      this.syncEventsService.emitInventorySyncEvent({
        type,
        variantId: entityId,
        userId: connection.UserId,
        sourceConnectionId,
        sourcePlatform: connection.PlatformType,
      });
    } else {
      this.syncEventsService.emitProductSyncEvent({
        type,
        productId: entityId,
        userId: connection.UserId,
        sourceConnectionId,
        sourcePlatform: connection.PlatformType,
      });
    }

    await this.activityLogService.logActivity({
      UserId: connection.UserId,
      EntityType: type.includes('INVENTORY') ? 'Inventory' : 'Product',
      EntityId: entityId,
      EventType: 'CROSS_PLATFORM_SYNC_INITIATED',
      Status: 'Success',
      Message: `Cross-platform sync initiated for ${type} (${entityId})`,
      Details: { sourceConnectionId, sourcePlatform: connection.PlatformType }
    });
  }
} 