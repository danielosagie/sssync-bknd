import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PlatformConnectionsService } from '../platform-connections/platform-connections.service';
import { InitialSyncService } from '../sync-engine/initial-sync.service'; // For queueReconciliationJob
import { QueueManagerService } from '../queue-manager.service';
import { SupabaseService } from '../common/supabase.service';

@Injectable()
export class TasksService {
    private readonly logger = new Logger(TasksService.name);

    constructor(
        private readonly configService: ConfigService,
        private readonly platformConnectionsService: PlatformConnectionsService,
        private readonly initialSyncService: InitialSyncService,
        private readonly queueManagerService: QueueManagerService,
        private readonly supabaseService: SupabaseService,
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
            const enabled = this.configService.get<string>('QUEUE_POLL_ENABLED');
            if (enabled && enabled.toLowerCase() === 'false') {
                this.logger.debug('[CRON - processQueuedJobs] Disabled via QUEUE_POLL_ENABLED=false');
                return;
            }
            // Process all jobs in the queue
            await this.queueManagerService.processAllJobs();
        } catch (error) {
            this.logger.error(`[CRON - processQueuedJobs] Error processing queued jobs: ${error.message}`, error.stack);
        }
    }

    // Add more scheduled tasks here if needed

    // Nightly job: compute linear reweighting for reranker post-adjustment
    @Cron(CronExpression.EVERY_DAY_AT_2AM, { name: 'nightlyRerankWeights' })
    async computeNightlyRerankWeights() {
        this.logger.log('[CRON - nightlyRerankWeights] Starting computation');
        try {
            const supabase = this.supabaseService.getServiceClient();
            // Pull recent feedback and rerank logs
            const { data: reranks } = await supabase
                .from('AiGeneratedContent')
                .select('Id, CreatedAt, ContentType, GeneratedText, Metadata')
                .gte('CreatedAt', new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString())
                .in('ContentType', ['rerank', 'feedback']);

            if (!Array.isArray(reranks) || reranks.length === 0) {
                this.logger.log('[CRON - nightlyRerankWeights] No recent logs. Skipping.');
                return;
            }

            // Very simple heuristic update: measure acceptance of reputable hosts and price-present
            let posPrice = 0, negPrice = 0, posHost = 0, negHost = 0;
            const hosts = ['amazon.com','ebay.com','bestbuy.com','target.com','walmart.com'];

            for (const row of reranks) {
                try {
                    const payload = JSON.parse(row.GeneratedText || '{}');
                    if (row.ContentType === 'feedback') {
                        const userPick = payload?.userPick;
                        const rerankerPick = payload?.rerankerPick;
                        if (!userPick || !rerankerPick) continue;
                        const pricePresent = !!userPick.price;
                        const host = (() => { try { return new URL(userPick.sourceUrl||'').hostname.replace(/^www\./,''); } catch { return ''; } })();
                        const isHost = hosts.some(h => host.endsWith(h));
                        if (pricePresent) posPrice++; else negPrice++;
                        if (isHost) posHost++; else negHost++;
                    }
                } catch {}
            }

            // Compute new small boosts (bounded)
            const priceBoost = Math.max(0, Math.min(0.08, (posPrice - negPrice) / Math.max(1, (posPrice + negPrice)) * 0.1 + 0.05));
            const hostBoost = Math.max(0, Math.min(0.12, (posHost - negHost) / Math.max(1, (posHost + negHost)) * 0.12 + 0.06));

            await supabase
                .from('AiGeneratedContent')
                .insert({
                    ContentType: 'rerank_weights',
                    SourceApi: 'nightly',
                    Prompt: 'weights-update',
                    GeneratedText: JSON.stringify({ priceBoost, hostBoost, hosts }),
                    Metadata: { windowDays: 7 },
                    IsActive: true,
                });

            this.logger.log(`[CRON - nightlyRerankWeights] Updated boosts: price=${priceBoost.toFixed(3)} host=${hostBoost.toFixed(3)}`);

        } catch (error) {
            this.logger.error(`[CRON - nightlyRerankWeights] Error: ${error.message}`, error.stack);
        }
    }
} 