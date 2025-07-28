import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PlatformConnectionsService } from '../platform-connections/platform-connections.service';
import { InitialSyncService } from '../sync-engine/initial-sync.service'; // For queueReconciliationJob
import { QueueManagerService } from '../queue-manager.service';

@Injectable()
export class TasksService {
    private readonly logger = new Logger(TasksService.name);

    constructor(
        private readonly platformConnectionsService: PlatformConnectionsService,
        private readonly initialSyncService: InitialSyncService,
        private readonly queueManagerService: QueueManagerService,
    ) {}

    // Example: Run once a day at 3 AM server time
    @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'dailyReconciliation' })
    async handleDailyReconciliation() {
        this.logger.log('[CRON - dailyReconciliation] Starting daily reconciliation task...');
        try {
            const connections = await this.platformConnectionsService.getAllEnabledConnections(); // Needs to be implemented
            if (connections.length === 0) {
                this.logger.log('[CRON - dailyReconciliation] No enabled connections found to reconcile.');
                return;
            }

            this.logger.log(`[CRON - dailyReconciliation] Found ${connections.length} enabled connections to reconcile.`);
            for (const connection of connections) {
                try {
                    this.logger.log(`[CRON - dailyReconciliation] Queueing reconciliation for connection: ${connection.Id} (${connection.PlatformType})`);
                    await this.initialSyncService.queueReconciliationJob(
                        connection.Id,
                        connection.UserId,
                        connection.PlatformType,
                    );
                } catch (error) {
                    this.logger.error(`[CRON - dailyReconciliation] Failed to queue reconciliation for connection ${connection.Id}: ${error.message}`, error.stack);
                }
            }
            this.logger.log('[CRON - dailyReconciliation] Finished queueing all reconciliation jobs.');
        } catch (error) {
            this.logger.error(`[CRON - dailyReconciliation] Error during daily reconciliation task: ${error.message}`, error.stack);
        }
    }

    // 🎯 NEW: Process queued jobs every 10 seconds
    @Cron('*/10 * * * * *', { name: 'processQueuedJobs' })
    async processQueuedJobs() {
        try {
            // Process all jobs in the queue
            await this.queueManagerService.processAllJobs();
        } catch (error) {
            this.logger.error(`[CRON - processQueuedJobs] Error processing queued jobs: ${error.message}`, error.stack);
        }
    }

    // Add more scheduled tasks here if needed
} 