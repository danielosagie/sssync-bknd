import { SimpleQueue } from './queue.interface';
import * as UltraLowQueue from './ultra-low-queue';
import { BullMQQueue } from './bullmq-queue';

let currentQueue: SimpleQueue = UltraLowQueue;
let highThroughputMode = false;
let requestTimestamps: number[] = [];

function recordRequest() {
  const now = Date.now();
  requestTimestamps.push(now);
  // Remove requests older than 15 seconds
  requestTimestamps = requestTimestamps.filter(ts => now - ts <= 15000);
}

function checkAndSwitchQueue() {
  const now = Date.now();
  // Count requests in the last second
  const recent = requestTimestamps.filter(ts => now - ts <= 1000).length;
  // Count requests in the last 15 seconds
  const last15s = requestTimestamps.length;

  if (!highThroughputMode && recent > 5 && last15s > 75) { // >5/sec for >15s
    currentQueue = BullMQQueue;
    highThroughputMode = true;
    console.log('[QueueManager] Switched to BullMQ queue');
  } else if (highThroughputMode && recent <= 5) {
    currentQueue = UltraLowQueue;
    highThroughputMode = false;
    console.log('[QueueManager] Switched to ultra-low queue');
  }
}

export async function enqueueJob(jobData: any) {
  recordRequest();
  checkAndSwitchQueue();
  await currentQueue.enqueueJob(jobData);
}

export async function processNextJob() {
  return currentQueue.processNextJob();
}

export async function processAllJobs() {
  if (currentQueue.processAllJobs) {
    return currentQueue.processAllJobs();
  }
} 