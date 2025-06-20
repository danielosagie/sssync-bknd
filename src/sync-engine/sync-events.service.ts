import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

export interface ProductSyncEvent {
  type: 'PRODUCT_CREATED' | 'PRODUCT_UPDATED' | 'PRODUCT_DELETED';
  productId: string;
  userId: string;
  sourceConnectionId: string;
  sourcePlatform: string;
  platformProductId?: string;
  webhookId?: string;
}

export interface InventorySyncEvent {
  type: 'INVENTORY_UPDATED';
  variantId: string;
  userId: string;
  sourceConnectionId: string;
  sourcePlatform: string;
  locationId?: string;
  newQuantity?: number;
  webhookId?: string;
}

@Injectable()
export class SyncEventsService {
  private readonly logger = new Logger(SyncEventsService.name);

  constructor(private eventEmitter: EventEmitter2) {}

  /**
   * Emit a product sync event that will trigger cross-platform propagation
   */
  emitProductSyncEvent(event: ProductSyncEvent): void {
    this.logger.log(`Emitting product sync event: ${event.type} for product ${event.productId} from ${event.sourcePlatform}`);
    this.eventEmitter.emit('product.sync', event);
  }

  /**
   * Emit an inventory sync event that will trigger cross-platform propagation
   */
  emitInventorySyncEvent(event: InventorySyncEvent): void {
    this.logger.log(`Emitting inventory sync event: ${event.type} for variant ${event.variantId} from ${event.sourcePlatform}`);
    this.eventEmitter.emit('inventory.sync', event);
  }

  /**
   * Emit a general sync success event for monitoring/logging
   */
  emitSyncSuccessEvent(data: {
    type: 'WEBHOOK_SUCCESS' | 'MANUAL_SYNC_SUCCESS' | 'SCHEDULED_SYNC_SUCCESS';
    userId: string;
    connectionId: string;
    platform: string;
    entityId?: string;
    entityType?: string;
    webhookId?: string;
  }): void {
    this.logger.debug(`Emitting sync success event: ${data.type} for ${data.platform}`);
    this.eventEmitter.emit('sync.success', data);
  }

  /**
   * Emit a sync error event for monitoring/alerting
   */
  emitSyncErrorEvent(data: {
    type: 'WEBHOOK_ERROR' | 'MANUAL_SYNC_ERROR' | 'SCHEDULED_SYNC_ERROR';
    userId: string;
    connectionId: string;
    platform: string;
    error: string;
    entityId?: string;
    entityType?: string;
    webhookId?: string;
  }): void {
    this.logger.warn(`Emitting sync error event: ${data.type} for ${data.platform} - ${data.error}`);
    this.eventEmitter.emit('sync.error', data);
  }
} 