export interface SimpleQueue {
  enqueueJob(jobData: any): Promise<void>;
  processNextJob(): Promise<any>;
  processAllJobs?(): Promise<void>;
} 