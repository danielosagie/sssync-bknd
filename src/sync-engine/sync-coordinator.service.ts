import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PlatformConnectionsService, PlatformConnection } from '../platform-connections/platform-connections.service';
import { PlatformAdapterRegistry } from '../platform-adapters/adapter.registry';
import { WEBHOOK_PROCESSING_QUEUE, PUSH_OPERATIONS_QUEUE } from './sync-engine.constants'; // Corrected import
import { ProductsService } from '../canonical-data/products.service';
import { InventoryService, CanonicalInventoryLevel } from '../canonical-data/inventory.service';
import { PlatformProductMappingsService, PlatformProductMapping } from '../platform-product-mappings/platform-product-mappings.service';
import { Product, ProductVariant as SupabaseProductVariant, InventoryLevel as SupabaseInventoryLevel } from '../common/types/supabase.types'; // Renamed to avoid clash
import { CanonicalProduct, CanonicalProductVariant } from '../platform-adapters/shopify/shopify.mapper'; // Added import
import { PushOperationJobData } from './sync-engine.types';
import { ActivityLogService } from '../common/activity-log.service';

@Injectable()
export class SyncCoordinatorService {
    private readonly logger = new Logger(SyncCoordinatorService.name);

    constructor(
        @InjectQueue(PUSH_OPERATIONS_QUEUE) private pushOperationsQueue: Queue<PushOperationJobData>,
        private readonly connectionService: PlatformConnectionsService,
        private readonly adapterRegistry: PlatformAdapterRegistry,
        private readonly productsService: ProductsService,
        private readonly inventoryService: InventoryService,
        private readonly mappingsService: PlatformProductMappingsService,
        private readonly activityLogService: ActivityLogService, 
    ) {}

    // Method called by WebhookController or a dedicated WebhookProcessor job
    async handleWebhook(platformType: string, payload: any, headers: Record<string, string>, webhookId?: string): Promise<void> {
        const logPrefix = webhookId ? `[${webhookId}]` : '';
        this.logger.log(`${logPrefix} Processing webhook for platform: ${platformType}`);
        
        // Additional log for payload structure inspection
        if (payload) {
            this.logger.debug(`${logPrefix} Webhook payload keys: ${Object.keys(payload).join(', ')}`);
        }

        const adapter = this.adapterRegistry.getAdapter(platformType);
        if (!adapter) {
            this.logger.error(`${logPrefix} No adapter found for platform type: ${platformType}. Cannot process webhook.`);
            return;
        }

        // Find the connection based on platform-specific identifiers in payload or headers
        let connection: PlatformConnection | null = null;
        const shopifyShopDomain = headers['x-shopify-shop-domain'];
        // Add other platform-specific header checks (e.g., Square merchant ID, Clover merchant ID if available in headers)

        if (platformType === 'shopify' && shopifyShopDomain) {
            const connections = await this.connectionService.getConnectionsByPlatformAndAttribute('shopify', 'shop', shopifyShopDomain);
            if (connections.length > 0) {
                connection = connections[0]; // Assuming one connection per shop domain for webhooks
                if (connections.length > 1) {
                    this.logger.warn(`Multiple Shopify connections found for shop domain ${shopifyShopDomain}. Using the first one: ${connection.Id}`);
                }
            } else {
                this.logger.error(`No Shopify connection found for shop domain: ${shopifyShopDomain} from webhook header.`);
                return;
            }
        } else if (platformType === 'clover') {
            // Example: Clover might send merchant_id in the payload or a specific header
            const merchantId = payload?.merchant_id || payload?.merchantId || headers['x-clover-merchant-id']; // Check common places
            if (merchantId) {
                const connections = await this.connectionService.getConnectionsByPlatformAndAttribute('clover', 'merchantId', merchantId);
                if (connections.length > 0) {
                    connection = connections[0];
                    if (connections.length > 1) {
                        this.logger.warn(`Multiple Clover connections found for merchant ID ${merchantId}. Using the first one: ${connection.Id}`);
                    }
                } else {
                    this.logger.error(`No Clover connection found for merchant ID: ${merchantId} from webhook.`);
                    return;
                }
            } else {
                this.logger.error('Could not determine Clover merchant ID from webhook payload or headers.');
                return;
            }
        } else if (platformType === 'square') {
            // Example: Square might send merchant_id in the payload (event.merchant_id) or a specific header
            const merchantId = payload?.merchant_id || payload?.event?.merchant_id || headers['x-square-merchant-id'];
            if (merchantId) {
                 const connections = await this.connectionService.getConnectionsByPlatformAndAttribute('square', 'merchantId', merchantId);
                 if (connections.length > 0) {
                    connection = connections[0];
                    if (connections.length > 1) {
                        this.logger.warn(`Multiple Square connections found for merchant ID ${merchantId}. Using the first one: ${connection.Id}`);
                    }
                } else {
                    this.logger.error(`No Square connection found for merchant ID: ${merchantId} from webhook.`);
                    return;
                }
            } else {
                this.logger.error('Could not determine Square merchant ID from webhook payload or headers.');
                return;
            }
        }
        // Add more platform identification logic here

        if (!connection) {
            this.logger.error(`${logPrefix} Could not identify a platform connection for webhook from ${platformType}. Headers: ${JSON.stringify(headers)}, Payload sample: ${JSON.stringify(payload).substring(0, 200)}`);
            return;
        }

        if (!connection.IsEnabled) {
            this.logger.log(`${logPrefix} Connection ${connection.Id} for ${platformType} (User: ${connection.UserId}) is disabled. Skipping webhook processing.`);
            return;
        }

        try {
            this.logger.log(`${logPrefix} Processing webhook for ${platformType}, connection ID ${connection.Id}, User ID ${connection.UserId}`);
            await adapter.processWebhook(connection, payload, headers, webhookId); // Pass connection, payload, headers, and webhookId
            
            // Update last sync success for webhook processing
            await this.connectionService.updateLastSyncSuccess(connection.Id, connection.UserId);
            
            // Log successful webhook processing
            await this.activityLogService.logActivity({
                UserId: connection.UserId,
                EntityType: 'Webhook',
                EntityId: webhookId || `webhook-${Date.now()}`,
                EventType: 'WEBHOOK_SYNC_SUCCESS',
                Status: 'Success',
                Message: `Webhook successfully processed for ${platformType}`,
                Details: { 
                    platform: platformType, 
                    connectionId: connection.Id,
                    webhookId 
                }
            });
        } catch (error) {
            this.logger.error(`${logPrefix} Error processing webhook payload for ${platformType} via adapter (Connection: ${connection.Id}): ${error.message}`, error.stack);
            
            // Log webhook processing error with user context
            await this.activityLogService.logActivity({
                UserId: connection.UserId,
                EntityType: 'Webhook',
                EntityId: webhookId || `webhook-error-${Date.now()}`,
                EventType: 'WEBHOOK_SYNC_ERROR',
                Status: 'Error',
                Message: `Webhook processing failed for ${platformType}: ${error.message}`,
                Details: { 
                    platform: platformType, 
                    connectionId: connection.Id, 
                    error: error.message,
                    webhookId 
                }
            });
        }
    }

    // --- Methods to QUEUE PUSH operations based on Canonical Data Changes ---
    async handleCanonicalProductCreation(productId: string, userId: string): Promise<void> {
        this.logger.log(`Queueing PRODUCT_CREATED job for ProductID: ${productId}, UserID: ${userId}`);
        await this.pushOperationsQueue.add('product-created', {
            userId,
            entityId: productId,
            changeType: 'PRODUCT_CREATED',
        });
    }

    async handleCanonicalProductUpdate(productId: string, userId: string): Promise<void> {
        this.logger.log(`Queueing PRODUCT_UPDATED job for ProductID: ${productId}, UserID: ${userId}`);
        await this.pushOperationsQueue.add('product-updated', {
            userId,
            entityId: productId,
            changeType: 'PRODUCT_UPDATED',
        });
    }

    async handleCanonicalProductDeletion(productId: string, userId: string): Promise<void> {
        this.logger.log(`Queueing PRODUCT_DELETED job for ProductID: ${productId}, UserID: ${userId}`);
        await this.pushOperationsQueue.add('product-deleted', {
            userId,
            entityId: productId,
            changeType: 'PRODUCT_DELETED',
        });
    }

    async handleCanonicalInventoryUpdate(variantId: string, userId: string): Promise<void> {
        this.logger.log(`Queueing INVENTORY_UPDATED job for VariantID: ${variantId}, UserID: ${userId}`);
        await this.pushOperationsQueue.add('inventory-updated', {
            userId,
            entityId: variantId,
            changeType: 'INVENTORY_UPDATED',
        });
    }


    // --- INTERNAL EXECUTION METHODS (Called by PushOperationsProcessor) ---

    public async _executeProductCreationPush(productId: string, userId: string): Promise<void> {
        this.logger.log(`Executing push for canonical product creation: ProductID ${productId}, UserID ${userId}`);
        const product: Product | null = await this.productsService.getProductById(productId);
        if (!product) {
            this.logger.error(`Product not found for ProductID: ${productId}. Cannot push creation.`);
            await this.activityLogService.logActivity({
                UserId: userId,
                EntityType: 'Product',
                EntityId: productId,
                EventType: 'PUSH_PRODUCT_CREATED_ERROR',
                Status: 'Error',
                Message: `Product not found (ID: ${productId}) during push execution.`
            });
            return;
        }
        if (product.UserId !== userId) {
            this.logger.error(`Product ${productId} does not belong to user ${userId}. Aborting creation push.`);
             await this.activityLogService.logActivity({
                UserId: userId,
                EntityType: 'Product',
                EntityId: productId,
                EventType: 'PUSH_PRODUCT_CREATED_AUTH_ERROR',
                Status: 'Error',
                Message: `User mismatch for Product ID: ${productId}. Expected ${product.UserId}.`
            });
            return;
        }

        const supabaseVariants: SupabaseProductVariant[] = await this.productsService.getVariantsByProductId(productId, userId);
        if (supabaseVariants.length === 0) {
            this.logger.warn(`No variants found for ProductID: ${productId}. Cannot push creation as most platforms require variants.`);
             await this.activityLogService.logActivity({
                UserId: userId,
                EntityType: 'Product',
                EntityId: productId,
                EventType: 'PUSH_PRODUCT_CREATED_NO_VARIANTS',
                Status: 'Warning',
                Message: `No variants for Product ID: ${productId}. Push aborted.`
            });
            return;
        }

        const allInventoryLevelsForProduct: CanonicalInventoryLevel[] = [];
        for (const variant of supabaseVariants) {
            if (!variant.Id) continue;
            const levels = await this.inventoryService.getInventoryLevelsForVariant(variant.Id);
            allInventoryLevelsForProduct.push(...levels.map(il => ({
                ProductVariantId: il.ProductVariantId,
                PlatformConnectionId: il.PlatformConnectionId,
                PlatformLocationId: il.PlatformLocationId,
                Quantity: il.Quantity,
            })));
        }

        const connections = await this.connectionService.getConnectionsForUser(userId);
        for (const connection of connections) {
            if (connection.IsEnabled /* && connection.SyncRules?.pushProductCreate */) {
                this.logger.log(`Attempting to push product creation to ${connection.PlatformType} for connection ${connection.Id}`);
                try {
                    const adapter = this.adapterRegistry.getAdapter(connection.PlatformType);
                    
                    const canonicalProductForAdapter: CanonicalProduct = {
                        Id: product.Id,
                        UserId: product.UserId,
                        IsArchived: product.IsArchived,
                        Title: supabaseVariants[0]?.Title || "Untitled Product", 
                        Description: supabaseVariants[0]?.Description || undefined,
                    };

                    const canonicalVariantsForAdapter: CanonicalProductVariant[] = supabaseVariants.map(v => ({
                        Id: v.Id!, 
                        ProductId: v.ProductId,
                        UserId: v.UserId,
                        Sku: v.Sku,
                        Barcode: v.Barcode,
                        Title: v.Title,
                        Description: v.Description,
                        Price: parseFloat(v.Price as any),
                        CompareAtPrice: v.CompareAtPrice ? parseFloat(v.CompareAtPrice as any) : undefined,
                        Cost: undefined, 
                        Weight: v.Weight ? parseFloat(v.Weight as any) : undefined,
                        WeightUnit: v.WeightUnit,
                        Options: v.Options as Record<string, string> || undefined,
                        IsArchived: product.IsArchived, 
                        RequiresShipping: (v as any).RequiresShipping,
                        IsTaxable: (v as any).IsTaxable,
                        TaxCode: (v as any).TaxCode,
                        ImageId: (v as any).ImageId, 
                    }));

                    const inventoryLevelsForAdapter = allInventoryLevelsForProduct.filter(
                        level => canonicalVariantsForAdapter.some(v => v.Id === level.ProductVariantId)
                    );

                    const { platformProductId, platformVariantIds } = await adapter.createProduct(
                        connection,
                        canonicalProductForAdapter,
                        canonicalVariantsForAdapter,
                        inventoryLevelsForAdapter 
                    );

                    this.logger.log(`Product created on ${connection.PlatformType} (Connection: ${connection.Id}). Platform Product ID: ${platformProductId}`);
                    await this.activityLogService.logActivity({
                        UserId: userId,
                        EntityType: 'Product',
                        EntityId: productId,
                        EventType: 'PRODUCT_PUSH_CREATED_SUCCESS',
                        Status: 'Success',
                        Message: `Product ${productId} (Platform: ${platformProductId}) pushed to ${connection.PlatformType}.`,
                        Details: {
                            platform: connection.PlatformType,
                            connectionId: connection.Id,
                            platformProductId,
                            platformVariantIds
                        }
                    });

                    for (const canonicalVariant of canonicalVariantsForAdapter) {
                        const platformVariantId = platformVariantIds[canonicalVariant.Id!];
                        if (platformVariantId) {
                            let existingMapping = await this.mappingsService.getMappingsByVariantIdAndConnection(canonicalVariant.Id!, connection.Id);
                            const mappingData: Partial<PlatformProductMapping> = {
                                PlatformConnectionId: connection.Id,
                                ProductVariantId: canonicalVariant.Id!,
                                PlatformProductId: platformProductId,
                                PlatformVariantId: platformVariantId,
                                PlatformSku: canonicalVariant.Sku,
                                LastSyncedAt: new Date().toISOString(),
                                SyncStatus: 'Success',
                                IsEnabled: true,
                            };
                            if (existingMapping) {
                                await this.mappingsService.updateMapping(existingMapping.Id, mappingData);
                            } else {
                                await this.mappingsService.createMapping(mappingData as Omit<PlatformProductMapping, 'Id' | 'CreatedAt' | 'UpdatedAt'>);
                            }
                        } else {
                            this.logger.warn(`No platform variant ID returned for canonical variant ${canonicalVariant.Id} (SKU: ${canonicalVariant.Sku}) from ${connection.PlatformType} adapter for product ${platformProductId}.`);
                             await this.activityLogService.logActivity({
                                UserId: userId,
                                EntityType: 'ProductVariant',
                                EntityId: canonicalVariant.Id || null,
                                EventType: 'PRODUCT_PUSH_CREATED_VARIANT_MAPPING_MISSING',
                                Status: 'Warning',
                                Message: `No platform variant ID for variant ${canonicalVariant.Id} (SKU: ${canonicalVariant.Sku}) on ${connection.PlatformType} for product ${platformProductId}`,
                                Details: {
                                    platform: connection.PlatformType,
                                    connectionId: connection.Id,
                                    platformProductId
                                }
                            });
                        }
                    }
                    await this.connectionService.updateConnectionData(connection.Id, userId, { LastSyncSuccessAt: new Date().toISOString(), Status: connection.Status });
                } catch (error) {
                    this.logger.error(`Failed to push product creation to ${connection.PlatformType} for connection ${connection.Id}: ${error.message}`, error.stack);
                    await this.connectionService.updateConnectionData(connection.Id, userId, { Status: 'error', LastSyncAttemptAt: new Date().toISOString() });
                    await this.activityLogService.logActivity({
                        UserId: userId,
                        EntityType: 'Product',
                        EntityId: productId,
                        EventType: 'PRODUCT_PUSH_CREATED_FAILED',
                        Status: 'Error',
                        Message: `Failed to push product ${productId} to ${connection.PlatformType}: ${error.message}`,
                        Details: {
                            platform: connection.PlatformType,
                            connectionId: connection.Id,
                            error: error.message,
                            stack: error.stack?.substring(0, 500)
                        }
                    });
                }
            }
        }
    }

    public async _executeProductUpdatePush(productId: string, userId: string): Promise<void> {
        this.logger.log(`Executing push for canonical product update: ProductID ${productId}, UserID ${userId}`);
        const product: Product | null = await this.productsService.getProductById(productId);
        if (!product) {
            this.logger.error(`Product not found for ProductID: ${productId}. Cannot execute update push.`);
            await this.activityLogService.logActivity({
                UserId: userId,
                EntityType: 'Product',
                EntityId: productId,
                EventType: 'PRODUCT_UPDATE_PUSH_PRODUCT_NOT_FOUND',
                Status: 'Error',
                Message: `Product not found (ID: ${productId}) during push execution.`
            });
            return;
        }
        if (product.UserId !== userId) {
            this.logger.error(`Product ${productId} does not belong to user ${userId}. Aborting update push.`);
            await this.activityLogService.logActivity({
                UserId: userId,
                EntityType: 'Product',
                EntityId: productId,
                EventType: 'PRODUCT_UPDATE_PUSH_AUTH_ERROR',
                Status: 'Error',
                Message: `User mismatch for Product ID: ${productId}. Expected ${product.UserId}.`
            });
            return;
        }

        const supabaseVariants: SupabaseProductVariant[] = await this.productsService.getVariantsByProductId(productId, userId);
        const allInventoryLevels: CanonicalInventoryLevel[] = [];
        for (const sv of supabaseVariants) { 
            if (!sv.Id) continue;
            const levels = await this.inventoryService.getInventoryLevelsForVariant(sv.Id);
            allInventoryLevels.push(...levels.map(il => ({
                Id: il.Id,
                ProductVariantId: il.ProductVariantId,
                PlatformConnectionId: il.PlatformConnectionId, 
                PlatformLocationId: il.PlatformLocationId, 
                Quantity: il.Quantity 
            })));
        }

        const connections = await this.connectionService.getConnectionsForUser(userId);
        for (const connection of connections) {
            if (connection.IsEnabled /* && connection.SyncRules?.pushProductUpdate */) {
                let existingMapping: PlatformProductMapping | null = null;
                if (supabaseVariants.length > 0 && supabaseVariants[0].Id) {
                    existingMapping = await this.mappingsService.getMappingsByVariantIdAndConnection(supabaseVariants[0].Id, connection.Id);
                }
                
                if (!existingMapping && supabaseVariants.length > 0) {
                    this.logger.warn(`No existing mapping for product ${productId} (via first variant) on ${connection.PlatformType} (conn ${connection.Id}). Consider creating.`);
                    await this.activityLogService.logActivity({
                        UserId: userId,
                        EntityType: 'Product',
                        EntityId: productId,
                        EventType: 'PRODUCT_PUSH_UPDATED_NO_MAPPING',
                        Status: 'Warning',
                        Message: `No mapping for product ${productId} on ${connection.PlatformType}. Update skipped, create might be needed.`,
                        Details: {
                            platform: connection.PlatformType,
                            connectionId: connection.Id
                        }
                    });
                    continue; 
                } else if (!existingMapping) {
                    this.logger.log(`Product ${productId} has no variants or no mapping on ${connection.PlatformType} (conn ${connection.Id}). Skipping update.`);
                    continue;
                }

                try {
                    const adapter = this.adapterRegistry.getAdapter(connection.PlatformType);
                    this.logger.log(`Pushing product update to ${connection.PlatformType} for connection ${connection.Id}, mapping ${existingMapping.Id}`);
                    
                    const canonicalProductForAdapter: CanonicalProduct = { 
                        Id: product.Id, 
                        UserId: product.UserId, 
                        Title: supabaseVariants[0]?.Title || product.Id, 
                        IsArchived: product.IsArchived, 
                        Description: supabaseVariants[0]?.Description || undefined,
                    };

                    const canonicalVariantsForAdapter: CanonicalProductVariant[] = supabaseVariants.map(v => ({
                        Id: v.Id,
                        ProductId: v.ProductId,
                        UserId: v.UserId,
                        Sku: v.Sku,
                        Barcode: v.Barcode,
                        Title: v.Title,
                        Description: v.Description,
                        Price: v.Price,
                        CompareAtPrice: v.CompareAtPrice,
                        Cost: undefined, 
                        Weight: v.Weight,
                        WeightUnit: v.WeightUnit,
                        Options: v.Options,
                        IsArchived: product.IsArchived,
                        RequiresShipping: v.RequiresShipping,
                        IsTaxable: v.IsTaxable,
                        TaxCode: v.TaxCode,
                        ImageId: v.ImageId,
                        PlatformSpecificData: {},
                    }));
                    
                    const relevantInventoryLevelsForAdapter = allInventoryLevels
                        .filter(il => 
                            il.PlatformConnectionId === connection.Id && 
                            supabaseVariants.some(v => v.Id === il.ProductVariantId)
                        );

                    await adapter.updateProduct(connection, existingMapping, canonicalProductForAdapter, canonicalVariantsForAdapter, relevantInventoryLevelsForAdapter);
                    this.logger.log(`Product update pushed to ${connection.PlatformType} for product mapping ${existingMapping.Id}`);
                    await this.mappingsService.updateMapping(existingMapping.Id, {
                        LastSyncedAt: new Date().toISOString(),
                        SyncStatus: 'Success',
                        SyncErrorMessage: null,
                    });
                    await this.activityLogService.logActivity({
                        UserId: userId,
                        EntityType: 'Product',
                        EntityId: productId,
                        EventType: 'PRODUCT_PUSH_UPDATED_SUCCESS',
                        Status: 'Success',
                        Message: `Product ${productId} updated on ${connection.PlatformType} (Mapping: ${existingMapping.Id}).`,
                        Details: {
                            platform: connection.PlatformType,
                            connectionId: connection.Id,
                            mappingId: existingMapping.Id
                        }
                    });
                     await this.connectionService.updateConnectionData(connection.Id, userId, { LastSyncSuccessAt: new Date().toISOString(), Status: connection.Status });
                } catch (error) {
                    this.logger.error(`Failed to push product update to ${connection.PlatformType} for mapping ${existingMapping.Id}: ${error.message}`, error.stack);
                    await this.mappingsService.updateMapping(existingMapping.Id, {
                        LastSyncedAt: new Date().toISOString(),
                        SyncStatus: 'Error',
                        SyncErrorMessage: error.message,
                    }).catch(e => this.logger.error(`Failed to update mapping status on error: ${e.message}`));
                    await this.activityLogService.logActivity({
                        UserId: userId,
                        EntityType: 'Product',
                        EntityId: productId,
                        EventType: 'PRODUCT_PUSH_UPDATED_FAILED',
                        Status: 'Error',
                        Message: `Failed to update product ${productId} on ${connection.PlatformType}: ${error.message}`,
                        Details: {
                            platform: connection.PlatformType,
                            connectionId: connection.Id,
                            mappingId: existingMapping.Id,
                            error: error.message,
                            stack: error.stack?.substring(0,500)
                        }
                    });
                     await this.connectionService.updateConnectionData(connection.Id, userId, { Status: 'error', LastSyncAttemptAt: new Date().toISOString() });
                }
            }
        }
    }

    public async _executeProductDeletionPush(productId: string, userId: string): Promise<void> {
        this.logger.log(`Executing push for canonical product deletion: ProductID ${productId}, UserID ${userId}`);
        const product = await this.productsService.getProductById(productId); 
        if (!product) {
            this.logger.error(`Product not found for ProductID: ${productId}. Cannot execute deletion push (likely already deleted locally).`);
            await this.activityLogService.logActivity({
                UserId: userId,
                EntityType: 'Product',
                EntityId: productId,
                EventType: 'PRODUCT_DELETE_PUSH_PRODUCT_NOT_FOUND',
                Status: 'Error',
                Message: `Product not found (ID: ${productId}) during push execution.`
            });
            return;
        }
        if (product.UserId !== userId) {
            this.logger.error(`Product ${productId} does not belong to user ${userId}. Aborting deletion push.`);
            await this.activityLogService.logActivity({
                UserId: userId,
                EntityType: 'Product',
                EntityId: productId,
                EventType: 'PRODUCT_DELETE_PUSH_AUTH_ERROR',
                Status: 'Error',
                Message: `User mismatch for Product ID: ${productId} during deletion. Expected ${product.UserId}.`
            });
            return;
        }

        const connections = await this.connectionService.getConnectionsForUser(userId);
        for (const connection of connections) {
            if (connection.IsEnabled /* && connection.SyncRules?.pushProductDelete */) {
                const mappings = await this.mappingsService.getMappingsByProductIdAndConnection(productId, connection.Id);
                if (mappings.length === 0) {
                    this.logger.log(`No mappings found for product ${productId} on connection ${connection.Id}. Nothing to delete on platform.`);
                    continue;
                }
                for (const mapping of mappings) {
                    try {
                        const adapter = this.adapterRegistry.getAdapter(connection.PlatformType);
                        this.logger.log(`Pushing product deletion to ${connection.PlatformType} for mapping ${mapping.Id}`);
                        await adapter.deleteProduct(connection, mapping);
                        this.logger.log(`Product deletion pushed to ${connection.PlatformType} for mapping ${mapping.Id}`);
                        await this.mappingsService.deleteMapping(mapping.Id);
                         await this.activityLogService.logActivity({
                            UserId: userId,
                            EntityType: 'Product',
                            EntityId: productId,
                            EventType: 'PRODUCT_PUSH_DELETED_SUCCESS',
                            Status: 'Success',
                            Message: `Product associated with mapping ${mapping.Id} (Canonical: ${productId}) deleted from ${connection.PlatformType}.`,
                            Details: {
                                platform: connection.PlatformType,
                                connectionId: connection.Id,
                                mappingId: mapping.Id,
                                platformProductId: mapping.PlatformProductId
                            }
                        });
                         await this.connectionService.updateConnectionData(connection.Id, userId, { LastSyncSuccessAt: new Date().toISOString(), Status: connection.Status });
                    } catch (error) {
                        this.logger.error(`Failed to push product deletion to ${connection.PlatformType} for mapping ${mapping.Id}: ${error.message}`, error.stack);
                        await this.activityLogService.logActivity({
                            UserId: userId,
                            EntityType: 'Product',
                            EntityId: productId,
                            EventType: 'PRODUCT_PUSH_DELETED_FAILED',
                            Status: 'Error',
                            Message: `Failed to delete product (mapping ${mapping.Id}) from ${connection.PlatformType}: ${error.message}`,
                            Details: {
                                platform: connection.PlatformType,
                                connectionId: connection.Id,
                                mappingId: mapping.Id,
                                error: error.message,
                                stack: error.stack?.substring(0,500)
                            }
                        });
                        // Decide if we should update connection status to error here, or if one mapping failure is isolated.
                        // For now, let one failure not mark the whole connection as error, but it did attempt.
                        await this.connectionService.updateConnectionData(connection.Id, userId, { LastSyncAttemptAt: new Date().toISOString(), Status: connection.Status });
                    }
                }
            }
        }
    }

    public async _executeInventoryUpdatePush(variantId: string, userId: string): Promise<void> {
        this.logger.log(`Executing push for canonical inventory update: VariantID ${variantId}, UserID ${userId}`);
        const variant: SupabaseProductVariant | null = await this.productsService.getVariantById(variantId); 

        if (!variant) {
            this.logger.error(`Variant not found for VariantID: ${variantId}. Cannot push inventory update.`);
            await this.activityLogService.logActivity({
                UserId: userId,
                EntityType: 'ProductVariant',
                EntityId: variantId,
                EventType: 'INVENTORY_UPDATE_PUSH_VARIANT_NOT_FOUND',
                Status: 'Error',
                Message: `Variant not found (ID: ${variantId}) during inventory push.`
            });
            return;
        }
        if (variant.UserId !== userId) {
            this.logger.error(`Variant ${variantId} does not belong to user ${userId}. Aborting inventory update push.`);
            await this.activityLogService.logActivity({
                UserId: userId,
                EntityType: 'ProductVariant',
                EntityId: variantId,
                EventType: 'INVENTORY_UPDATE_PUSH_AUTH_ERROR',
                Status: 'Error',
                Message: `User mismatch for Variant ID: ${variantId}. Expected ${variant.UserId}.`
            });
            return;
        }

        const supabaseInventoryLevels: SupabaseInventoryLevel[] = await this.inventoryService.getInventoryLevelsForVariant(variantId);
        const canonicalInventoryLevels: CanonicalInventoryLevel[] = supabaseInventoryLevels.map(sl => ({
            Id: sl.Id,
            ProductVariantId: sl.ProductVariantId,
            PlatformConnectionId: sl.PlatformConnectionId,
            PlatformLocationId: sl.PlatformLocationId,
            Quantity: sl.Quantity,
            LastPlatformUpdateAt: sl.LastPlatformUpdateAt ? new Date(sl.LastPlatformUpdateAt) : null,
        }));

        if (canonicalInventoryLevels.length === 0) {
            this.logger.warn(`No canonical inventory levels for VariantID: ${variantId}. Nothing to push.`);
        }
        
        const connections = await this.connectionService.getConnectionsForUser(userId);
        for (const connection of connections) {
            if (connection.IsEnabled /* && connection.SyncRules?.pushInventoryUpdate */) {
                const mapping = await this.mappingsService.getMappingsByVariantIdAndConnection(variantId, connection.Id);
                if (mapping && mapping.PlatformVariantId) { 
                    try {
                        const adapter = this.adapterRegistry.getAdapter(connection.PlatformType);
                        this.logger.log(`Pushing inventory update to ${connection.PlatformType} for connection ${connection.Id}, mapping ${mapping.Id}`);
                        
                        const inventoryUpdatesForAdapter: Array<{ mapping: PlatformProductMapping; level: CanonicalInventoryLevel }> = canonicalInventoryLevels 
                            .filter(il => il.PlatformConnectionId === connection.Id && il.ProductVariantId === variant.Id)
                            .map(il => ({
                                mapping: mapping, 
                                level: il,      
                            }));

                        if (inventoryUpdatesForAdapter.length > 0) {
                            await adapter.updateInventoryLevels(connection, inventoryUpdatesForAdapter);
                            this.logger.log(`Inventory update pushed to ${connection.PlatformType} for mapping ${mapping.Id}`);
                            await this.mappingsService.updateMapping(mapping.Id, {
                                LastSyncedAt: new Date().toISOString(),
                                SyncStatus: 'Success',
                                SyncErrorMessage: null,
                            });
                            await this.activityLogService.logActivity({
                                UserId: userId,
                                EntityType: 'ProductVariant',
                                EntityId: variantId,
                                EventType: 'INVENTORY_PUSH_UPDATED_SUCCESS',
                                Status: 'Success',
                                Message: `Inventory for variant ${variantId} (Mapping: ${mapping.Id}) updated on ${connection.PlatformType}.`,
                                Details: {
                                    platform: connection.PlatformType,
                                    connectionId: connection.Id,
                                    mappingId: mapping.Id,
                                    levelsPushed: inventoryUpdatesForAdapter.length
                                }
                            });
                            await this.connectionService.updateConnectionData(connection.Id, userId, { LastSyncSuccessAt: new Date().toISOString(), Status: connection.Status });
                        } else {
                            this.logger.log(`No specific inventory levels for variant ${variantId} on connection ${connection.Id} to push. Mapping ${mapping.Id} exists.`);
                        }
                    } catch (error) {
                        this.logger.error(`Failed to push inventory update to ${connection.PlatformType} for mapping ${mapping.Id}: ${error.message}`, error.stack);
                        await this.mappingsService.updateMapping(mapping.Id, {
                            LastSyncedAt: new Date().toISOString(),
                            SyncStatus: 'Error',
                            SyncErrorMessage: error.message,
                        }).catch(e => this.logger.error(`Failed to update mapping status on error: ${e.message}`));
                         await this.activityLogService.logActivity({
                            UserId: userId,
                            EntityType: 'ProductVariant',
                            EntityId: variantId,
                            EventType: 'INVENTORY_PUSH_UPDATED_FAILED',
                            Status: 'Error',
                            Message: `Failed to update inventory for variant ${variantId} (Mapping: ${mapping.Id}) on ${connection.PlatformType}: ${error.message}`,
                            Details: {
                                platform: connection.PlatformType,
                                connectionId: connection.Id,
                                mappingId: mapping.Id,
                                error: error.message,
                                stack: error.stack?.substring(0,500)
                            }
                        });
                        await this.connectionService.updateConnectionData(connection.Id, userId, { Status: 'error', LastSyncAttemptAt: new Date().toISOString() });
                    }
                } else {
                    this.logger.warn(`No mapping or PlatformVariantId for variant ${variantId} on ${connection.PlatformType} (conn ${connection.Id}). Cannot push inventory update.`);
                    await this.activityLogService.logActivity({
                        UserId: userId,
                        EntityType: 'ProductVariant',
                        EntityId: variantId,
                        EventType: 'INVENTORY_PUSH_UPDATED_NO_MAPPING',
                        Status: 'Warning',
                        Message: `No mapping/platform ID for variant ${variantId} on ${connection.PlatformType}. Inventory update skipped.`,
                        Details: {
                            platform: connection.PlatformType,
                            connectionId: connection.Id
                        }
                    });
                }
            }
        }
    }
} 