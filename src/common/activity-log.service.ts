import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from './supabase.service';
import { SupabaseClient } from '@supabase/supabase-js';

export interface ActivityLogEntry {
    Id?: string; // bigserial, will be auto-generated
    Timestamp?: string; // timestamptz, will default to now()
    UserId?: string | null; // uuid, nullable
    PlatformConnectionId?: string | null; // uuid, nullable
    EntityType?: string | null; // text, nullable - 'Product', 'ProductVariant', 'InventoryLevel', 'PlatformMapping', etc.
    EntityId?: string | null; // text, nullable - the ID of the entity being acted upon
    EventType: string; // text, required - the type of event/action
    Status: string; // text, required - 'Success', 'Failed', 'In Progress', etc.
    Message: string; // text, required - human-readable description
    Details?: Record<string, any> | null; // jsonb, nullable - additional structured data
}

export interface ProductEventDetails {
    productId?: string;
    variantId?: string;
    sku?: string;
    title?: string;
    price?: number;
    previousValues?: Record<string, any>;
    newValues?: Record<string, any>;
    platformProductId?: string;
    platformVariantId?: string;
    operation?: 'create' | 'update' | 'delete' | 'archive' | 'unarchive';
    source?: 'user' | 'webhook' | 'sync' | 'api';
    webhookId?: string;
}

export interface InventoryEventDetails {
    variantId?: string;
    platformConnectionId?: string;
    locationId?: string;
    locationName?: string;
    previousQuantity?: number;
    newQuantity?: number;
    quantityDelta?: number;
    reason?: string;
    source?: 'user' | 'webhook' | 'sync' | 'api';
    webhookId?: string;
}

export interface PlatformEventDetails {
    connectionId?: string;
    platformType?: string;
    platformName?: string;
    operation?: 'create' | 'update' | 'delete' | 'enable' | 'disable' | 'sync' | string;
    syncDirection?: 'push' | 'pull' | 'bidirectional';
    itemsProcessed?: number;
    itemsSucceeded?: number;
    itemsFailed?: number;
    duration?: number; // in milliseconds
    errors?: string[];
}

export interface UserActionDetails {
    action?: string;
    screen?: string;
    component?: string;
    targetId?: string;
    targetType?: string;
    inputData?: Record<string, any>;
    userAgent?: string;
    ipAddress?: string;
}

@Injectable()
export class ActivityLogService {
    private readonly logger = new Logger(ActivityLogService.name);

    constructor(private readonly supabaseService: SupabaseService) {}

    private getSupabaseClient(): SupabaseClient {
        return this.supabaseService.getClient();
    }

    /**
     * Generic method to log any activity
     */
    async logActivity(entry: ActivityLogEntry): Promise<void> {
        try {
            const supabase = this.getSupabaseClient();
            
            const { error } = await supabase
                .from('ActivityLogs')
                .insert({
                    Timestamp: entry.Timestamp || new Date().toISOString(),
                    UserId: entry.UserId || null,
                    PlatformConnectionId: entry.PlatformConnectionId || null,
                    EntityType: entry.EntityType || null,
                    EntityId: entry.EntityId || null,
                    EventType: entry.EventType,
                    Status: entry.Status,
                    Message: entry.Message,
                    Details: entry.Details || null,
                });

            if (error) {
                this.logger.error(`Failed to log activity: ${error.message}`, error);
            } else {
                this.logger.debug(`Activity logged: ${entry.EventType} - ${entry.Message}`);
            }
        } catch (error) {
            this.logger.error(`Exception while logging activity: ${error.message}`, error);
        }
    }

    /**
     * Log product-related events (create, update, delete, etc.)
     */
    async logProductEvent(
        eventType: string,
        status: string,
        message: string,
        details: ProductEventDetails,
        userId?: string,
        platformConnectionId?: string
    ): Promise<void> {
        await this.logActivity({
            UserId: userId,
            PlatformConnectionId: platformConnectionId,
            EntityType: 'Product',
            EntityId: details.productId || details.variantId,
            EventType: eventType,
            Status: status,
            Message: message,
            Details: details,
        });
    }

    /**
     * Log inventory-related events
     */
    async logInventoryEvent(
        eventType: string,
        status: string,
        message: string,
        details: InventoryEventDetails,
        userId?: string,
        platformConnectionId?: string
    ): Promise<void> {
        await this.logActivity({
            UserId: userId,
            PlatformConnectionId: platformConnectionId,
            EntityType: 'InventoryLevel',
            EntityId: details.variantId,
            EventType: eventType,
            Status: status,
            Message: message,
            Details: details,
        });
    }

    /**
     * Log platform/sync-related events
     */
    async logPlatformEvent(
        eventType: string,
        status: string,
        message: string,
        details: PlatformEventDetails,
        userId?: string,
        platformConnectionId?: string
    ): Promise<void> {
        await this.logActivity({
            UserId: userId,
            PlatformConnectionId: platformConnectionId || details.connectionId,
            EntityType: 'PlatformConnection',
            EntityId: details.connectionId,
            EventType: eventType,
            Status: status,
            Message: message,
            Details: details,
        });
    }

    /**
     * Log user interface actions
     */
    async logUserAction(
        eventType: string,
        status: string,
        message: string,
        details: UserActionDetails,
        userId?: string
    ): Promise<void> {
        await this.logActivity({
            UserId: userId,
            EntityType: 'UserAction',
            EntityId: details.targetId,
            EventType: eventType,
            Status: status,
            Message: message,
            Details: details,
        });
    }

    /**
     * Log webhook processing events
     */
    async logWebhookEvent(
        eventType: string,
        status: string,
        message: string,
        webhookId: string,
        platformConnectionId?: string,
        userId?: string,
        details?: Record<string, any>
    ): Promise<void> {
        await this.logActivity({
            UserId: userId,
            PlatformConnectionId: platformConnectionId,
            EntityType: 'Webhook',
            EntityId: webhookId,
            EventType: eventType,
            Status: status,
            Message: message,
            Details: {
                webhookId,
                ...details,
            },
        });
    }

    /**
     * Get activity logs for a specific user with filtering
     */
    async getUserActivityLogs(
        userId: string,
        options: {
            entityType?: string;
            eventType?: string;
            status?: string;
            platformConnectionId?: string;
            startDate?: string;
            endDate?: string;
            limit?: number;
            offset?: number;
        } = {}
    ): Promise<ActivityLogEntry[]> {
        try {
            const supabase = this.getSupabaseClient();
            let query = supabase
                .from('ActivityLogs')
                .select('*')
                .eq('UserId', userId)
                .order('Timestamp', { ascending: false });

            if (options.entityType) {
                query = query.eq('EntityType', options.entityType);
            }
            if (options.eventType) {
                query = query.eq('EventType', options.eventType);
            }
            if (options.status) {
                query = query.eq('Status', options.status);
            }
            if (options.platformConnectionId) {
                query = query.eq('PlatformConnectionId', options.platformConnectionId);
            }
            if (options.startDate) {
                query = query.gte('Timestamp', options.startDate);
            }
            if (options.endDate) {
                query = query.lte('Timestamp', options.endDate);
            }
            if (options.limit) {
                query = query.limit(options.limit);
            }
            if (options.offset) {
                query = query.range(options.offset, options.offset + (options.limit || 50) - 1);
            }

            const { data, error } = await query;

            if (error) {
                this.logger.error(`Failed to fetch activity logs: ${error.message}`, error);
                return [];
            }

            return data || [];
        } catch (error) {
            this.logger.error(`Exception while fetching activity logs: ${error.message}`, error);
            return [];
        }
    }

    /**
     * Get activity logs for a specific entity
     */
    async getEntityActivityLogs(
        entityType: string,
        entityId: string,
        userId?: string
    ): Promise<ActivityLogEntry[]> {
        try {
            const supabase = this.getSupabaseClient();
            let query = supabase
                .from('ActivityLogs')
                .select('*')
                .eq('EntityType', entityType)
                .eq('EntityId', entityId)
                .order('Timestamp', { ascending: false });

            if (userId) {
                query = query.eq('UserId', userId);
            }

            const { data, error } = await query;

            if (error) {
                this.logger.error(`Failed to fetch entity activity logs: ${error.message}`, error);
                return [];
            }

            return data || [];
        } catch (error) {
            this.logger.error(`Exception while fetching entity activity logs: ${error.message}`, error);
            return [];
        }
    }

    /**
     * Get activity statistics for reporting
     */
    async getActivityStats(
        userId: string,
        timeRange: 'day' | 'week' | 'month' | 'year' = 'week'
    ): Promise<{
        totalEvents: number;
        eventsByType: Record<string, number>;
        eventsByStatus: Record<string, number>;
        eventsByPlatform: Record<string, number>;
    }> {
        try {
            const supabase = this.getSupabaseClient();
            
            let startDate: Date;
            const now = new Date();
            
            switch (timeRange) {
                case 'day':
                    startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
                    break;
                case 'week':
                    startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                    break;
                case 'month':
                    startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                    break;
                case 'year':
                    startDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
                    break;
            }

            const { data, error } = await supabase
                .from('ActivityLogs')
                .select('EventType, Status, PlatformConnectionId')
                .eq('UserId', userId)
                .gte('Timestamp', startDate.toISOString());

            if (error) {
                this.logger.error(`Failed to fetch activity stats: ${error.message}`, error);
                return {
                    totalEvents: 0,
                    eventsByType: {},
                    eventsByStatus: {},
                    eventsByPlatform: {},
                };
            }

            const events = data || [];
            const eventsByType: Record<string, number> = {};
            const eventsByStatus: Record<string, number> = {};
            const eventsByPlatform: Record<string, number> = {};

            events.forEach(event => {
                eventsByType[event.EventType] = (eventsByType[event.EventType] || 0) + 1;
                eventsByStatus[event.Status] = (eventsByStatus[event.Status] || 0) + 1;
                if (event.PlatformConnectionId) {
                    eventsByPlatform[event.PlatformConnectionId] = (eventsByPlatform[event.PlatformConnectionId] || 0) + 1;
                }
            });

            return {
                totalEvents: events.length,
                eventsByType,
                eventsByStatus,
                eventsByPlatform,
            };
        } catch (error) {
            this.logger.error(`Exception while fetching activity stats: ${error.message}`, error);
            return {
                totalEvents: 0,
                eventsByType: {},
                eventsByStatus: {},
                eventsByPlatform: {},
            };
        }
    }

    // Convenience methods for common operations

    async logProductCreate(productId: string, variantId: string, details: Partial<ProductEventDetails>, userId?: string): Promise<void> {
        await this.logProductEvent(
            'PRODUCT_CREATED',
            'Success',
            `Product created: ${details.title || productId}`,
            { productId, variantId, operation: 'create', source: 'user', ...details },
            userId
        );
    }

    async logProductUpdate(productId: string, variantId: string, details: Partial<ProductEventDetails>, userId?: string): Promise<void> {
        await this.logProductEvent(
            'PRODUCT_UPDATED',
            'Success',
            `Product updated: ${details.title || productId}`,
            { productId, variantId, operation: 'update', source: 'user', ...details },
            userId
        );
    }

    async logProductDelete(productId: string, variantId: string, details: Partial<ProductEventDetails>, userId?: string): Promise<void> {
        await this.logProductEvent(
            'PRODUCT_DELETED',
            'Success',
            `Product deleted: ${details.title || productId}`,
            { productId, variantId, operation: 'delete', source: 'user', ...details },
            userId
        );
    }

    async logInventoryUpdate(
        variantId: string,
        previousQuantity: number,
        newQuantity: number,
        locationId: string,
        details: Partial<InventoryEventDetails>,
        userId?: string,
        platformConnectionId?: string
    ): Promise<void> {
        await this.logInventoryEvent(
            'INVENTORY_UPDATED',
            'Success',
            `Inventory updated: ${previousQuantity} → ${newQuantity} at ${details.locationName || locationId}`,
            {
                variantId,
                previousQuantity,
                newQuantity,
                quantityDelta: newQuantity - previousQuantity,
                locationId,
                source: 'user',
                ...details,
            },
            userId,
            platformConnectionId
        );
    }

    async logSyncOperation(
        connectionId: string,
        operation: string,
        status: string,
        details: Partial<PlatformEventDetails>,
        userId?: string
    ): Promise<void> {
        await this.logPlatformEvent(
            `SYNC_${operation.toUpperCase()}`,
            status,
            `Sync ${operation}: ${status}`,
            { connectionId, operation, ...details },
            userId,
            connectionId
        );
    }
}
