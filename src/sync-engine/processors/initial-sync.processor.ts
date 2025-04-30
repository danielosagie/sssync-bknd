import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger, InternalServerErrorException } from '@nestjs/common';
import { INITIAL_SYNC_QUEUE } from '../sync-engine.constants'; // Adjust path
import { PlatformConnectionsService } from '../../platform-connections/platform-connections.service'; // Adjust path
import { PlatformAdapterRegistry } from '../../platform-adapters/adapter.registry'; // Adjust path
import { MappingService } from '../mapping.service'; // Adjust path
import { JobData } from '../initial-sync.service'; // Adjust path
import { SupabaseService } from '../../common/supabase.service'; // Inject Supabase for transactions if needed
// Import Canonical Data services (ProductsService, InventoryService etc.)

@Processor(INITIAL_SYNC_QUEUE)
export class InitialSyncProcessor extends WorkerHost {
    private readonly logger = new Logger(InitialSyncProcessor.name);

    constructor(
         private readonly connectionService: PlatformConnectionsService,
         private readonly mappingService: MappingService,
         private readonly adapterRegistry: PlatformAdapterRegistry,
         private readonly supabaseService: SupabaseService, // Inject for transactions
         // Inject Canonical Data services
         // private readonly productsService: ProductsService,
         // private readonly inventoryService: InventoryService,
    ) {
        super();
    }

    async process(job: Job<JobData, any, string>): Promise<any> {
         const { connectionId, userId, platformType } = job.data;
         this.logger.log(`Processing initial SYNC job ${job.id} for connection ${connectionId} (${platformType})...`);

         try {
             // Ensure connection is still valid and maybe in 'activating_sync' status?
             const connection = await this.connectionService.getConnectionById(connectionId, userId);
             if (!connection) {
                  this.logger.warn(`Job ${job.id}: Connection ${connectionId} not found. Skipping sync.`);
                  return { status: 'skipped', reason: 'Connection not found' };
             }
             // Set status to syncing
             await this.connectionService.updateConnectionStatus(connectionId, userId, 'syncing');

             const adapter = this.adapterRegistry.getAdapter(platformType);
             const apiClient = adapter.getApiClient(connection);
             const mapper = adapter.getMapper();
             const syncRules = connection.SyncRules || { createNew: false }; // Default rules
             const confirmedMappingsData = await this.mappingService.getConfirmedMappings(connectionId); // <<< NEED THIS METHOD in MappingService

             if (!confirmedMappingsData) {
                  this.logger.error(`Job ${job.id}: Confirmed mappings not found for connection ${connectionId}. Cannot proceed.`);
                   await this.connectionService.updateConnectionStatus(connectionId, userId, 'error'); // Error status
                   throw new Error('Confirmed mappings missing for initial sync.');
             }

             // TODO: Refine - Fetch data needed for sync (maybe only items marked link/create?)
             // Or fetch all again? Fetching all is simpler but less efficient.
             this.logger.log(`Job ${job.id}: Fetching ${platformType} data for sync...`);
             const platformData = await apiClient.fetchAllRelevantData(); // Fetch all for simplicity now

             // Use Supabase transaction for data integrity
             const supabase = this.supabaseService.getClient();
             const { error: txError } = await supabase.rpc('execute_in_transaction', async () => { // Assuming helper function or handle manually

                 // TODO: Implement core logic within transaction:
                 // 1. Iterate platformData.products/variants
                 // 2. Find corresponding action ('link', 'create', 'ignore') from confirmedMappingsData
                 // 3. If 'link':
                 //    - Use mappingService.createOrUpdateMapping(...) to save PlatformProductMapping
                 //    - Fetch platform inventory, map, call InventoryService.updateLevel(...)
                 // 4. If 'create' AND syncRules.createNew:
                 //    - Map to canonical using mapper
                 //    - Call ProductsService.createProductWithVariant(...)
                 //    - Get new sssyncVariantId
                 //    - Use mappingService.createOrUpdateMapping(...)
                 //    - Fetch/update inventory as above
                 // 5. Log progress and handle item-level errors within loop

             }); // End transaction

             if (txError) {
                  this.logger.error(`Job ${job.id}: Transaction failed during initial sync: ${txError.message}`);
                  throw new InternalServerErrorException('Initial sync database operation failed.');
             }

             // Set final status (e.g., 'syncing' - becomes active/ongoing sync)
             // Note: 'syncing' might represent both initial and ongoing. Maybe just 'active'?
             await this.connectionService.updateConnectionStatus(connectionId, userId, 'syncing');
             await this.connectionService.updateLastSyncSuccess(connectionId, userId);

             this.logger.log(`Job ${job.id}: Initial sync complete for connection ${connectionId}.`);
             return { status: 'completed' };

         } catch (error) {
              this.logger.error(`Job ${job.id}: Failed during initial sync for connection ${connectionId}: ${error.message}`, error.stack);
              await this.connectionService.updateConnectionStatus(connectionId, userId, 'error').catch(e => this.logger.error(`Failed to update status to error: ${e.message}`));
              throw error; // Re-throw for BullMQ retries
         }
    }
} 