import { Injectable, Logger, forwardRef, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { SimpleQueue } from './queue.interface';
import { JobData } from './sync-engine/initial-sync.service'; // Assuming JobData is defined here or move to a common types file
import { InitialScanProcessor } from './sync-engine/processors/initial-scan.processor';
import { InitialSyncProcessor } from './sync-engine/processors/initial-sync.processor';

const QUEUE_KEY = 'ultra-low-queue';

@Injectable()
export class UltraLowQueueService implements SimpleQueue {
  private readonly logger = new Logger(UltraLowQueueService.name);
  private redis: Redis;

  constructor(
    private readonly configService: ConfigService,
    private readonly initialScanProcessor: InitialScanProcessor, // Proper injection
    @Inject(forwardRef(() => InitialSyncProcessor))
    private readonly initialSyncProcessor: InitialSyncProcessor, // Uncommented injection
  ) {
    const redisUrl = this.configService.get<string>('REDIS_URL');
    if (!redisUrl) {
      this.logger.error('REDIS_URL is not defined. UltraLowQueueService cannot start.');
      throw new Error('REDIS_URL is not defined for UltraLowQueueService.');
    }
    this.redis = new Redis(redisUrl);
    this.redis.on('error', (err) => {
      this.logger.error('Redis client error in UltraLowQueueService:', err);
    });
    this.redis.on('connect', () => {
      this.logger.log('Redis client connected in UltraLowQueueService.');
    });
  }

  async enqueueJob(jobData: JobData): Promise<void> {
    await this.redis.lpush(QUEUE_KEY, JSON.stringify(jobData));
    this.logger.debug(`[UltraLowQueue] Enqueued job type ${jobData.type}: ${JSON.stringify(jobData)}`);
  }

  async processNextJob(): Promise<any> {
    const jobStr = await this.redis.rpop(QUEUE_KEY);
    if (jobStr) {
      const job = JSON.parse(jobStr) as { id?:string, data: JobData };
      this.logger.log(`[UltraLowQueue] Processing job: ${jobStr}`);
      
      const mockBullMqJob = {
        id: job.id || `ultra-low-${Date.now()}`,
        data: job.data,
      } as any;
      
      if (job.data.type === 'initial-scan') {
        this.logger.log(`[UltraLowQueue] Delegating to InitialScanProcessor for job ID: ${job.id || 'N/A'}`);
        try {
          await this.initialScanProcessor.process(mockBullMqJob);
          return job.data;
        } catch (error) {
          this.logger.error(`[UltraLowQueue] Error processing 'initial-scan' job ${job.id || 'N/A'}: ${error.message}`, error.stack);
          return null;
        }
      } else if (job.data.type === 'initial-sync') {
        this.logger.log(`[UltraLowQueue] Delegating to InitialSyncProcessor for job ID: ${job.id || 'N/A'}`);
        try {
          await this.initialSyncProcessor.process(mockBullMqJob);
          return job.data;
        } catch (error) {
          this.logger.error(`[UltraLowQueue] Error processing 'initial-sync' job ${job.id || 'N/A'}: ${error.message}`, error.stack);
          return null;
        }
      } else {
        this.logger.warn(`[UltraLowQueue] Unknown job type: ${job.data.type}. Skipping.`);
        return null;
      }
    }
    return null;
  }

  async processAllJobs(): Promise<void> {
    this.logger.log('[UltraLowQueue] Processing all jobs in queue...');
    let jobData;
    while ((jobData = await this.processNextJob())) {
      // Processing happens in processNextJob
    }
    this.logger.log('[UltraLowQueue] Finished processing all jobs.');
  }
} 