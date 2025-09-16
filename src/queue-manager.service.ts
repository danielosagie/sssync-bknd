import { Injectable, Logger } from '@nestjs/common';
import { SimpleQueue } from './queue.interface';
import { JobData } from './sync-engine/initial-sync.service'; // Or a common types file
import { UltraLowQueueService } from './ultra-low-queue.service';
import { BullMQQueueService } from './bullmq-queue.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, Job } from 'bullmq';
import { INITIAL_SCAN_QUEUE, INITIAL_SYNC_QUEUE, PUSH_OPERATIONS_QUEUE, RECONCILIATION_QUEUE } from './sync-engine/sync-engine.constants';

// Constants for dynamic switching logic
const HIGH_TRAFFIC_THRESHOLD_REQUESTS_PER_SECOND = 100;
const HIGH_TRAFFIC_DURATION_SECONDS = 60;
const SCALE_DOWN_IDLE_SECONDS = 60; // Switch back to low queue if no requests for 60s

@Injectable()
export class QueueManagerService {
  private readonly logger = new Logger(QueueManagerService.name);
  private currentQueue: SimpleQueue;
  private highThroughputMode = false;
  private requestTimestamps: number[] = [];
  private lastRequestTimestamp: number = 0;
  private readonly queues: Record<string, Queue>;

  constructor(
    private readonly ultraLowQueueService: UltraLowQueueService,
    private readonly bullMQQueueService: BullMQQueueService,
    @InjectQueue(INITIAL_SCAN_QUEUE) private initialScanQueue: Queue,
    @InjectQueue(INITIAL_SYNC_QUEUE) private initialSyncQueue: Queue,
    @InjectQueue(PUSH_OPERATIONS_QUEUE) private pushOperationsQueue: Queue,
    @InjectQueue(RECONCILIATION_QUEUE) private reconciliationQueue: Queue,
  ) {
    this.currentQueue = this.ultraLowQueueService;
    this.logger.log('QueueManagerService initialized, starting with UltraLowQueueService.');

    this.queues = {
      [INITIAL_SCAN_QUEUE]: this.initialScanQueue,
      [INITIAL_SYNC_QUEUE]: this.initialSyncQueue,
      [PUSH_OPERATIONS_QUEUE]: this.pushOperationsQueue,
      [RECONCILIATION_QUEUE]: this.reconciliationQueue,
    };

    setInterval(() => this.checkAndScaleDown(), SCALE_DOWN_IDLE_SECONDS * 1000 / 2); // Check frequently
  }

  private recordRequest() {
    const now = Date.now();
    this.requestTimestamps.push(now);
    this.lastRequestTimestamp = now;
    // Remove requests older than HIGH_TRAFFIC_DURATION_SECONDS + a buffer
    this.requestTimestamps = this.requestTimestamps.filter(ts => now - ts <= (HIGH_TRAFFIC_DURATION_SECONDS + 5) * 1000);
    this.checkAndSwitchQueue();
  }

  private checkAndSwitchQueue() {
    const now = Date.now();
    const recentRequestsInWindow = this.requestTimestamps.filter(ts => now - ts <= HIGH_TRAFFIC_DURATION_SECONDS * 1000);
    
    // Calculate requests per second within this window
    // Find the earliest and latest timestamp in the window
    if (recentRequestsInWindow.length === 0) return; // No recent requests to analyze

    const minTs = Math.min(...recentRequestsInWindow);
    const maxTs = Math.max(...recentRequestsInWindow);
    const windowDurationSeconds = (maxTs - minTs) / 1000;

    let requestsPerSecondInWindow = 0;
    if (windowDurationSeconds > 0) {
        requestsPerSecondInWindow = recentRequestsInWindow.length / windowDurationSeconds;
    }

    if (
      !this.highThroughputMode &&
      recentRequestsInWindow.length >= HIGH_TRAFFIC_THRESHOLD_REQUESTS_PER_SECOND * HIGH_TRAFFIC_DURATION_SECONDS &&
      requestsPerSecondInWindow >= HIGH_TRAFFIC_THRESHOLD_REQUESTS_PER_SECOND
    ) {
      this.logger.log(`High traffic detected (${requestsPerSecondInWindow.toFixed(2)} req/s over ${windowDurationSeconds.toFixed(2)}s). Switching to BullMQQueueService.`);
      this.currentQueue = this.bullMQQueueService;
      this.highThroughputMode = true;
      // Start BullMQ worker lazily
      this.bullMQQueueService.startWorker().catch(err => this.logger.error('Failed to start BullMQ worker:', err));
    } 
    // Scaling down is handled by checkAndScaleDown()
  }

  private checkAndScaleDown() {
    const now = Date.now();
    if (this.highThroughputMode && (now - this.lastRequestTimestamp > SCALE_DOWN_IDLE_SECONDS * 1000)) {
      this.logger.log(`Low traffic detected (idle for ${SCALE_DOWN_IDLE_SECONDS}s). Switching back to UltraLowQueueService.`);
      this.currentQueue = this.ultraLowQueueService;
      this.highThroughputMode = false;
      this.requestTimestamps = []; // Reset request timestamps after scaling down
      // Stop BullMQ worker to reduce Redis chatter
      this.bullMQQueueService.stopWorker().catch(err => this.logger.error('Failed to stop BullMQ worker:', err));
    }
  }

  async enqueueJob(jobData: JobData): Promise<string> {
    this.recordRequest(); // Record every enqueue attempt for rate checking
    this.logger.debug(`Enqueueing job with type ${jobData.type} via ${this.currentQueue.constructor.name}`);
    
    // Generate a unique job ID
    const jobId = `${jobData.type}-${(jobData as any).connectionId || 'no-connection'}-${Date.now()}`;
    
    // Add the job ID to the job data
    const jobDataWithId = { ...jobData, jobId };
    
    await this.currentQueue.enqueueJob(jobDataWithId);
    
    return jobId;
  }

  async processNextJob(): Promise<any> {
    // This method might be called by an external trigger (e.g., HTTP endpoint for on-demand processing)
    this.logger.log(`processNextJob called on QueueManager, delegating to ${this.currentQueue.constructor.name}`);
    return this.currentQueue.processNextJob(); 
  }

  async processAllJobs(): Promise<void> {
    this.logger.log(`processAllJobs called on QueueManager, delegating to ${this.currentQueue.constructor.name}`);
    if (this.currentQueue === this.ultraLowQueueService) {
        return this.ultraLowQueueService.processAllJobs();
    }
    // For BullMQ, processing is typically handled by its worker.
    // If processAllJobs is truly needed for BullMQ, it would need a more complex implementation
    // to fetch and process all waiting jobs, which is not standard for a live worker.
    this.logger.warn('processAllJobs for BullMQQueueService is a no-op as worker handles processing.');
  }

  async getJobById(jobId: string): Promise<Job | null> {
    this.logger.debug(`Attempting to find job with ID: ${jobId}`);
    for (const queueName in this.queues) {
      const queue = this.queues[queueName];
      const job = await queue.getJob(jobId);
      if (job) {
        this.logger.debug(`Found job ${jobId} in queue ${queueName}`);
        return job;
      }
    }
    this.logger.warn(`Job with ID ${jobId} not found in any managed queues.`);
    return null;
  }
} 