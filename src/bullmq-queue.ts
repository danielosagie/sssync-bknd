import { Queue, Job } from 'bullmq';
import IORedis from 'ioredis';
import { SimpleQueue } from './queue.interface';

let connection: IORedis | null = null;
let queueInstance: Queue | null = null;
const BULLMQ_HIGH_QUEUE_NAME = 'bullmq-high-queue';

function getBullMQInstances(): { connection: IORedis; queue: Queue } {
  if (connection && queueInstance) {
    return { connection, queue: queueInstance };
  }

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error('[BullMQQueue] REDIS_URL is not defined. Cannot initialize BullMQ connection.');
  }

  console.log(`[BullMQQueue] Initializing IORedis connection with URL: ${redisUrl}`);
  connection = new IORedis(redisUrl, {
    maxRetriesPerRequest: null, // Important for BullMQ
    enableReadyCheck: false,    // Important for BullMQ
  });

  connection.on('error', (err) => {
    console.error('[BullMQQueue] IORedis connection error:', err);
  });
  connection.on('connect', () => {
    console.log('[BullMQQueue] IORedis connection established.');
  });

  console.log(`[BullMQQueue] Initializing BullMQ Queue: ${BULLMQ_HIGH_QUEUE_NAME}`);
  queueInstance = new Queue(BULLMQ_HIGH_QUEUE_NAME, { connection });
  
  queueInstance.on('error', (err) => {
    console.error(`[BullMQQueue] BullMQ Queue (${BULLMQ_HIGH_QUEUE_NAME}) error:`, err);
  });

  return { connection, queue: queueInstance };
}

// Optionally, you can have a persistent worker elsewhere. For on-demand, we process jobs here.

export const BullMQQueue: SimpleQueue = {
  async enqueueJob(jobData: any) {
    const { queue } = getBullMQInstances();
    await queue.add('job', jobData);
    console.log(`[BullMQQueue] Enqueued job to ${BULLMQ_HIGH_QUEUE_NAME}:`, jobData);
  },

  async processNextJob() {
    const { queue } = getBullMQInstances();
    const waitingJobs = await queue.getWaiting(0, 0); // Get the oldest waiting job
    if (waitingJobs.length === 0) {
      // console.log(`[BullMQQueue] No waiting jobs in ${BULLMQ_HIGH_QUEUE_NAME}.`);
      return null;
    }
    const job = waitingJobs[0];
    
    console.log(`[BullMQQueue] Processing BullMQ job ${job.id} from ${BULLMQ_HIGH_QUEUE_NAME}:`, job.data);
    // TODO: Replace this with your actual job processing logic for BullMQ jobs.
    // This current implementation only moves the job to completed.
    // You might want to call a specific service method based on job.data.type, for example.
    await job.moveToCompleted('processed on-demand', 'completed', true);
    // The parameters are: returnValue, token, fetchNext
    // Using 'completed' as the token and true for fetchNext
    console.log(`[BullMQQueue] Moved job ${job.id} to completed.`);
    return job.data; // Return the job data as per SimpleQueue interface
  },

  async processAllJobs() {
    // Ensure instances are ready before loop
    getBullMQInstances(); 
    let jobData;
    console.log(`[BullMQQueue] Starting to process all jobs in ${BULLMQ_HIGH_QUEUE_NAME}...`);
    while ((jobData = await this.processNextJob())) {
      // Each job is processed and logged within processNextJob()
    }
    console.log(`[BullMQQueue] Finished processing all available jobs in ${BULLMQ_HIGH_QUEUE_NAME}.`);
  },
}; 