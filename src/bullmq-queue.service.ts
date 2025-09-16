import { Injectable, Logger, OnModuleInit, OnModuleDestroy, forwardRef, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { SimpleQueue } from './queue.interface';
import { JobData } from './sync-engine/initial-sync.service';
import { InitialScanProcessor } from './sync-engine/processors/initial-scan.processor';
import { InitialSyncProcessor } from './sync-engine/processors/initial-sync.processor';
import { ProductAnalysisProcessor } from './products/processors/product-analysis.processor';
import { ProductAnalysisJobData } from './products/types/product-analysis-job.types';
import { MatchJobProcessor } from './products/processors/match-job.processor';
import { MatchJobData } from './products/types/match-job.types';
import { GenerateJobProcessor } from './products/processors/generate-job.processor';
import { GenerateJobData } from './products/types/generate-job.types';
import { RegenerateJobProcessor } from './products/processors/regenerate-job.processor';
import { RegenerateJobData } from './products/types/regenerate-job.types';

const BULLMQ_HIGH_QUEUE_NAME = 'bullmq-high-queue';

@Injectable()
export class BullMQQueueService implements SimpleQueue, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BullMQQueueService.name);
  private connection: IORedis | null = null;
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private isWorkerActive = false;
  private readonly redisUrl: string | undefined;

  constructor(
    private readonly configService: ConfigService,
    @Inject(forwardRef(() => InitialScanProcessor))
    private readonly initialScanProcessor: InitialScanProcessor, 
    @Inject(forwardRef(() => InitialSyncProcessor))
    private readonly initialSyncProcessor: InitialSyncProcessor,
    @Inject(forwardRef(() => ProductAnalysisProcessor))
    private readonly productAnalysisProcessor: ProductAnalysisProcessor,
    @Inject(forwardRef(() => MatchJobProcessor))
    private readonly matchJobProcessor: MatchJobProcessor,
    @Inject(forwardRef(() => GenerateJobProcessor))
    private readonly generateJobProcessor: GenerateJobProcessor,
    @Inject(forwardRef(() => RegenerateJobProcessor))
    private readonly regenerateJobProcessor: RegenerateJobProcessor,
  ) {
    this.redisUrl = this.configService.get<string>('REDIS_URL');
    if (!this.redisUrl) {
      this.logger.error('REDIS_URL is not defined. BullMQQueueService will remain disabled until configured.');
    }
  }

  private async ensureConnection(): Promise<void> {
    if (this.connection && this.queue) return;
    if (!this.redisUrl) {
      throw new Error('REDIS_URL is not defined for BullMQQueueService.');
    }
    this.connection = new IORedis(this.redisUrl, {
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
    if (!this.connection) {
      throw new Error('IORedis connection not initialized before starting worker');
    }
    if (!this.initialScanProcessor || !this.initialSyncProcessor || !this.productAnalysisProcessor || !this.matchJobProcessor || !this.generateJobProcessor) {
        this.logger.error('Required processors not available. Worker cannot be initialized.');
        return; 
    }
    this.worker = new Worker(
      BULLMQ_HIGH_QUEUE_NAME,
      async (job: Job<JobData>) => {
        this.logger.log(`[BullMQWorker] Processing job ${job.id} of type ${job.data.type}`);
        if (job.data.type === 'initial-scan') {
          try {
            await this.initialScanProcessor.process(job as any); 
          } catch (error) {
            this.logger.error(`[BullMQWorker] Error processing 'initial-scan' job ${job.id}: ${error.message}`, error.stack);
            throw error; 
          }
        } else if (job.data.type === 'initial-sync') {
          try {
            this.logger.log(`[BullMQWorker] Delegating 'initial-sync' job ${job.id} to InitialSyncProcessor.`);
            await this.initialSyncProcessor.process(job as any); // Using actual processor
          } catch (error) {
            this.logger.error(`[BullMQWorker] Error processing 'initial-sync' job ${job.id}: ${error.message}`, error.stack);
            throw error; 
          }
        } else if (job.data.type === 'product-analysis') { // NEW: Handle product analysis jobs
          try {
            this.logger.log(`[BullMQWorker] Delegating 'product-analysis' job ${job.id} to ProductAnalysisProcessor.`);
            await this.productAnalysisProcessor.process(job as Job<ProductAnalysisJobData>);
          } catch (error) {
            this.logger.error(`[BullMQWorker] Error processing 'product-analysis' job ${job.id}: ${error.message}`, error.stack);
            throw error;
          }
        } else if (job.data.type === 'match-job') { // NEW: Handle match jobs
          try {
            this.logger.log(`[BullMQWorker] Delegating 'match-job' job ${job.id} to MatchJobProcessor.`);
            await this.matchJobProcessor.process(job as Job<MatchJobData>);
          } catch (error) {
            this.logger.error(`[BullMQWorker] Error processing 'match-job' job ${job.id}: ${error.message}`, error.stack);
            throw error;
          }
        } else if ((job.data as any).type === 'generate-job') { // NEW: Handle generate jobs
          try {
            this.logger.log(`[BullMQWorker] Delegating 'generate-job' job ${job.id} to GenerateJobProcessor.`);
            await this.generateJobProcessor.process(job as unknown as Job<GenerateJobData>);
          } catch (error) {
            this.logger.error(`[BullMQWorker] Error processing 'generate-job' job ${job.id}: ${error.message}`, error.stack);
            throw error;
          }
        } else if ((job.data as any).type === 'regenerate-job') { // NEW: Handle regenerate jobs
          try {
            this.logger.log(`[BullMQWorker] Delegating 'regenerate-job' job ${job.id} to RegenerateJobProcessor.`);
            await this.regenerateJobProcessor.process(job as unknown as Job<RegenerateJobData>);
          } catch (error) {
            this.logger.error(`[BullMQWorker] Error processing 'regenerate-job' job ${job.id}: ${error.message}`, error.stack);
            throw error;
          }
        } else {
          this.logger.warn(`[BullMQWorker] Unknown job type: ${job.data.type}. Job ${job.id} will be marked as failed.`);
          throw new Error(`Unknown job type: ${job.data.type}`);
        }
      },
      {
        connection: this.connection!,
      }
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
    this.logger.log('BullMQQueueService initialized. Worker will start lazily on demand.');
  }

  async onModuleDestroy() {
    this.logger.log('Closing BullMQQueueService resources...');
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
      this.logger.log('BullMQ Worker closed.');
    }
    if (this.queue) {
      await this.queue.close();
      this.queue = null;
      this.logger.log('BullMQ Queue closed.');
    }
    if (this.connection) {
      await this.connection.quit();
      this.connection = null;
      this.logger.log('IORedis connection closed for BullMQQueueService.');
    }
  }

  async startWorker(): Promise<void> {
    if (this.isWorkerActive) return;
    await this.ensureConnection();
    this.initializeWorker();
    this.isWorkerActive = !!this.worker;
    if (this.isWorkerActive) {
      this.logger.log('BullMQ worker started.');
    }
  }

  async stopWorker(): Promise<void> {
    if (!this.isWorkerActive) return;
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
    this.isWorkerActive = false;
    this.logger.log('BullMQ worker stopped.');
  }

  async enqueueJob(jobData: JobData): Promise<void> {
    // Use a unique job ID to prevent duplicates if needed, or let BullMQ generate one.
    const jobId = jobData.type ? `${jobData.type}-${(jobData as any).connectionId || (jobData as any).jobId}-${Date.now()}` : undefined;
    await this.ensureConnection();
    await this.queue!.add(jobData.type || 'default-job', jobData, { jobId });
    this.logger.debug(`[BullMQQueue] Enqueued job type ${jobData.type} with ID ${jobId}: ${JSON.stringify(jobData)}`);
  }

  // processNextJob is typically not used when a Worker is active, but implemented for SimpleQueue interface.
  // This could be used for an on-demand scenario if the worker wasn't started.
  async processNextJob(): Promise<any> {
    this.logger.warn('[BullMQQueue] processNextJob called. Typically, the BullMQ Worker handles job processing.');
    await this.ensureConnection();
    const jobs = await this.queue!.getWaiting(0, 0); 
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
      } else if (this.productAnalysisProcessor && jobToProcess.data.type === 'product-analysis') { // NEW: Handle product analysis in manual processing
        try {
            await this.productAnalysisProcessor.process(jobToProcess as Job<ProductAnalysisJobData>);
            await jobToProcess.moveToCompleted('processed manually', 'token', false);
            return jobToProcess.data;
        } catch (err) {
            this.logger.error('Manual processNextJob failed for product-analysis:', err);
            await jobToProcess.moveToFailed(err, 'token', false);
            return null;
        }
      } else if (this.matchJobProcessor && jobToProcess.data.type === 'match-job') { // NEW: Handle match jobs in manual processing
        try {
            await this.matchJobProcessor.process(jobToProcess as Job<MatchJobData>);
            await jobToProcess.moveToCompleted('processed manually', 'token', false);
            return jobToProcess.data;
        } catch (err) {
            this.logger.error('Manual processNextJob failed for match-job:', err);
            await jobToProcess.moveToFailed(err, 'token', false);
            return null;
        }
      } else if (this.generateJobProcessor && (jobToProcess.data as any).type === 'generate-job') { // NEW: Handle generate jobs in manual processing
        try {
            await this.generateJobProcessor.process(jobToProcess as unknown as Job<GenerateJobData>);
            await jobToProcess.moveToCompleted('processed manually', 'token', false);
            return jobToProcess.data;
        } catch (err) {
            this.logger.error('Manual processNextJob failed for generate-job:', err);
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