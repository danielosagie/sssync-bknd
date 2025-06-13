import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { RECONCILIATION_QUEUE } from '../sync-engine.constants';
import { PlatformConnectionsService } from '../../platform-connections/platform-connections.service';
import { MappingService } from '../mapping.service';
import { PlatformAdapterRegistry } from '../../platform-adapters/adapter.registry';
import { ReconciliationJobData } from '../initial-sync.service';
import { ProductsService } from '../../canonical-data/products.service';

@Processor(RECONCILIATION_QUEUE)
export class ReconciliationProcessor extends WorkerHost {
    private readonly logger = new Logger(ReconciliationProcessor.name);

    constructor(
        private readonly connectionService: PlatformConnectionsService,
        private readonly mappingService: MappingService,
        private readonly adapterRegistry: PlatformAdapterRegistry,
        private readonly productsService: ProductsService,
    ) {
        super();
        this.logger.log('ReconciliationProcessor initialized');
    }

    async process(job: Job<ReconciliationJobData, any, string>): Promise<any> {
        const { connectionId, userId, platformType } = job.data;
        this.logger.log(`[RECONCILE JOB] Processing job ${job.id} for connection ${connectionId} (${platformType})`);

        try {
            await job.updateProgress({ progress: 5, description: 'Initializing reconciliation...'});
            const connection = await this.connectionService.getConnectionById(connectionId, userId);
            if (!connection) {
                throw new Error(`Connection ${connectionId} not found for user ${userId}`);
            }

            // Status is already 'reconciling', set by the frontend call.
            
            const adapter = this.adapterRegistry.getAdapter(platformType);
            if (!adapter) {
                throw new Error(`No adapter found for platform type: ${platformType}`);
            }

            const apiClient = adapter.getApiClient(connection);
            this.logger.log(`[RECONCILE JOB] Fetching all platform data for connection ${connectionId}`);
            await job.updateProgress({ progress: 15, description: `Fetching products from ${platformType}...`});
            
            // This is a simplified reconciliation: re-fetch everything and generate new suggestions.
            // A true reconciliation would involve diffing against existing canonical data.
            const platformData = await apiClient.fetchAllRelevantData(connection);
            this.logger.log(`[RECONCILE JOB] Fetched ${platformData.products?.length || 0} products from ${platformType}.`);
            await job.updateProgress({ progress: 50, description: `Analyzing ${platformData.products?.length || 0} products...`});

            this.logger.log(`[RECONCILE JOB] Generating new mapping suggestions...`);
            const variantsForSuggestions = platformData.products.flatMap(p => 
                p.variants.edges.map(vEdge => {
                    const variantNode = vEdge.node;
                    return {
                        id: variantNode.id, 
                        sku: variantNode.sku,
                        barcode: variantNode.barcode,
                        title: p.title,
                        price: variantNode.price, 
                        imageUrl: p.media?.edges?.[0]?.node?.preview?.image?.url || null,
                    };
                })
            );

            const suggestions = await this.mappingService.generateSuggestions(
               { products: [], variants: variantsForSuggestions }, 
               userId, 
               platformType
            );
            this.logger.log(`[RECONCILE JOB] Generated ${suggestions.length} new suggestions.`);
            await job.updateProgress({ progress: 90, description: 'Finalizing suggestions...'});

            const currentPlatformSpecificData = connection.PlatformSpecificData || {};
            const updatedPlatformSpecificData = { 
                ...currentPlatformSpecificData, 
                mappingSuggestions: suggestions, // Overwrite with new suggestions
                lastReconciliationAt: new Date().toISOString(),
            };
            
            await this.connectionService.updateConnectionData(connectionId, userId, { 
                PlatformSpecificData: updatedPlatformSpecificData 
            });
            
            await this.connectionService.updateConnectionStatus(connectionId, userId, 'needs_review');
            this.logger.log(`[RECONCILE JOB] Job ${job.id} completed. Connection ${connectionId} status updated to 'needs_review'.`);
            await job.updateProgress({ progress: 100, description: 'Review ready!'});

            return { status: 'success', newSuggestionCount: suggestions.length };

        } catch (error) {
            this.logger.error(`[RECONCILE JOB] Job ${job.id} failed for connection ${connectionId}: ${error.message}`, error.stack);
            await this.connectionService.updateConnectionStatus(connectionId, userId, 'error').catch(e => 
                this.logger.error(`Failed to update status to error: ${e.message}`)
            );
            throw error; 
        }
    }
} 