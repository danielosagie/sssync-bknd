import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { SimpleQueue } from './queue.interface';
import { JobData } from './sync-engine/initial-sync.service';
import { InitialScanProcessor } from './sync-engine/processors/initial-scan.processor';

const BULLMQ_HIGH_QUEUE_NAME = 'bullmq-high-queue';

@Injectable()
export class BullMQQueueService implements SimpleQueue, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BullMQQueueService.name);
  private connection: IORedis;
  private queue: Queue;
  private worker: Worker | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly initialScanProcessor: InitialScanProcessor, // Proper injection
  ) {
    const redisUrl = this.configService.get<string>('REDIS_URL');
    if (!redisUrl) {
      this.logger.error('REDIS_URL is not defined. BullMQQueueService cannot start.');
      throw new Error('REDIS_URL is not defined for BullMQQueueService.');
    }
    // BullMQ recommends specific options for IORedis
    this.connection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    this.queue = new Queue(BULLMQ_HIGH_QUEUE_NAME, { connection: this.connection });

    this.connection.on('error', (err) => {
      this.logger.error('IORedis connection error in BullMQQueueService:', err);
    });
    this.connection.on('connect', () => {
      this.logger.log('IORedis connection established in BullMQQueueService.');
    });
  }

  private initializeWorker(): void {
    if (!this.initialScanProcessor) {
        this.logger.error('InitialScanProcessor not available. Worker cannot be initialized.');
        return; // Should not happen if DI is correct
    }
    this.worker = new Worker(
      BULLMQ_HIGH_QUEUE_NAME,
      async (job: Job<JobData>) => {
        this.logger.log(`[BullMQWorker] Processing job ${job.id} of type ${job.data.type}`);
        if (job.data.type === 'initial-scan') {
          try {
            await this.initialScanProcessor.process(job as any); // Use this.initialScanProcessor
          } catch (error) {
            this.logger.error(`[BullMQWorker] Error processing 'initial-scan' job ${job.id}: ${error.message}`, error.stack);
            throw error; 
          }
        } else {
          this.logger.warn(`[BullMQWorker] Unknown job type: ${job.data.type}. Job ${job.id} will be marked as failed.`);
          throw new Error(`Unknown job type: ${job.data.type}`);
        }
      },
      { connection: this.connection }
    );

    this.worker.on('completed', (job) => {
      this.logger.log(`[BullMQWorker] Job ${job.id} completed.`);
    });

    this.worker.on('failed', (job, err) => {
      this.logger.error(`[BullMQWorker] Job ${job?.id} failed: ${err.message}`, err.stack);
    });
    this.logger.log('BullMQ Worker initialized and listening to queue:', BULLMQ_HIGH_QUEUE_NAME);
  }

  async onModuleInit() {
    this.logger.log('BullMQQueueService initializing worker...');
    this.initializeWorker(); // Initialize worker now that dependencies should be resolved
  }

  async onModuleDestroy() {
    this.logger.log('Closing BullMQQueueService resources...');
    if (this.worker) {
      await this.worker.close();
      this.logger.log('BullMQ Worker closed.');
    }
    await this.queue.close();
    this.logger.log('BullMQ Queue closed.');
    await this.connection.quit();
    this.logger.log('IORedis connection closed for BullMQQueueService.');
  }

  async enqueueJob(jobData: JobData): Promise<void> {
    // Use a unique job ID to prevent duplicates if needed, or let BullMQ generate one.
    const jobId = jobData.type ? `${jobData.type}-${jobData.connectionId}-${Date.now()}` : undefined;
    await this.queue.add(jobData.type || 'default-job', jobData, { jobId });
    this.logger.debug(`[BullMQQueue] Enqueued job type ${jobData.type} with ID ${jobId}: ${JSON.stringify(jobData)}`);
  }

  // processNextJob is typically not used when a Worker is active, but implemented for SimpleQueue interface.
  // This could be used for an on-demand scenario if the worker wasn't started.
  async processNextJob(): Promise<any> {
    this.logger.warn('[BullMQQueue] processNextJob called. Typically, the BullMQ Worker handles job processing.');
    const jobs = await this.queue.getWaiting(0, 0); 
    if (jobs.length > 0) {
      const jobToProcess = jobs[0];
      this.logger.log(`[BullMQQueue] Manually attempting to process job ${jobToProcess.id}`);
      if (this.initialScanProcessor && jobToProcess.data.type === 'initial-scan') {
        try {
            await this.initialScanProcessor.process(jobToProcess as any);
            await jobToProcess.moveToCompleted('processed manually', 'token', false);
            return jobToProcess.data;
        } catch (err) {
            this.logger.error('Manual processNextJob failed:', err);
            await jobToProcess.moveToFailed(err, 'token', false);
            return null;
        }
      } else {
        this.logger.warn('No suitable processor or job type for manual processing via processNextJob.');
      }
      return jobToProcess.data; 
    }
    return null;
  }
} 