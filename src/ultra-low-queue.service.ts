import { Injectable, Logger, forwardRef, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { SimpleQueue } from './queue.interface';
import { JobData } from './sync-engine/initial-sync.service'; // Assuming JobData is defined here or move to a common types file
import { InitialScanProcessor } from './sync-engine/processors/initial-scan.processor';
import { InitialSyncProcessor } from './sync-engine/processors/initial-sync.processor';
import { MatchJobProcessor } from './products/processors/match-job.processor';
import { MatchJobData } from './products/types/match-job.types';
import { GenerateJobProcessor } from './products/processors/generate-job.processor';
import { GenerateJobData } from './products/types/generate-job.types';
import { RegenerateJobProcessor } from './products/processors/regenerate-job.processor';
import { RegenerateJobData } from './products/types/regenerate-job.types';

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
    private readonly matchJobProcessor: MatchJobProcessor, // NEW: Match job processor
    @Inject(forwardRef(() => GenerateJobProcessor))
    private readonly generateJobProcessor: GenerateJobProcessor, // NEW: Generate job processor
    @Inject(forwardRef(() => RegenerateJobProcessor))
    private readonly regenerateJobProcessor: RegenerateJobProcessor, // NEW: Regenerate job processor
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
      const parsedJob = JSON.parse(jobStr);
      this.logger.log(`[UltraLowQueue] Processing job: ${jobStr}`);
      
      // Handle both job formats:
      // 1. Legacy format: { id?, data: JobData }
      // 2. Direct format: JobData (for match-job, etc.)
      let job: { id?: string, data: JobData };
      
      if (parsedJob.data && parsedJob.data.type) {
        // Legacy format
        job = parsedJob as { id?: string, data: JobData };
      } else if (parsedJob.type) {
        // Direct format - wrap it
        job = {
          id: parsedJob.jobId || `ultra-low-${Date.now()}`,
          data: parsedJob as JobData
        };
      } else {
        this.logger.error(`[UltraLowQueue] Invalid job format: ${jobStr}`);
        return null;
      }
      
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
      } else if (job.data.type === 'match-job') {
        this.logger.log(`[UltraLowQueue] Delegating to MatchJobProcessor for job ID: ${job.id || 'N/A'}`);
        this.logger.log(`[UltraLowQueue] Match job data: ${JSON.stringify(job.data, null, 2)}`);
        try {
          this.logger.log(`[UltraLowQueue] Starting MatchJobProcessor.process()...`);
          await this.matchJobProcessor.process(mockBullMqJob as any);
          this.logger.log(`[UltraLowQueue] MatchJobProcessor.process() completed successfully`);
          return job.data;
        } catch (error) {
          this.logger.error(`[UltraLowQueue] Error processing 'match-job' job ${job.id || 'N/A'}: ${error.message}`, error.stack);
          return null;
        }
      } else if ((job.data as any).type === 'generate-job') {
        this.logger.log(`[UltraLowQueue] Delegating to GenerateJobProcessor for job ID: ${job.id || 'N/A'}`);
        this.logger.log(`[UltraLowQueue] Generate job data: ${JSON.stringify(job.data, null, 2)}`);
        try {
          await this.generateJobProcessor.process(mockBullMqJob as unknown as import('bullmq').Job<GenerateJobData>);
          this.logger.log(`[UltraLowQueue] GenerateJobProcessor.process() completed successfully`);
          return job.data;
        } catch (error) {
          this.logger.error(`[UltraLowQueue] Error processing 'generate-job' job ${job.id || 'N/A'}: ${error.message}`, error.stack);
          return null;
        }
      } else if ((job.data as any).type === 'regenerate-job') {
        this.logger.log(`[UltraLowQueue] Delegating to RegenerateJobProcessor for job ID: ${job.id || 'N/A'}`);
        this.logger.log(`[UltraLowQueue] Regenerate job data: ${JSON.stringify(job.data, null, 2)}`);
        try {
          await this.regenerateJobProcessor.process(mockBullMqJob as unknown as import('bullmq').Job<RegenerateJobData>);
          this.logger.log(`[UltraLowQueue] RegenerateJobProcessor.process() completed successfully`);
          return job.data;
        } catch (error) {
          this.logger.error(`[UltraLowQueue] Error processing 'regenerate-job' job ${job.id || 'N/A'}: ${error.message}`, error.stack);
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