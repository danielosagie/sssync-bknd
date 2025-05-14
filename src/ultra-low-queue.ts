import Redis from 'ioredis';

const QUEUE_KEY = 'ultra-low-queue';
let redis: Redis | null = null;

function getRedisClient(): Redis {
  if (redis) {
    return redis;
  }

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error('REDIS_URL is not defined in environment variables. Cannot initialize ultra-low-queue client.');
  }
  
  console.log(`[UltraLowQueue] Initializing Redis client with URL (sensitive parts may be masked by Redis lib): ${redisUrl}`);
  redis = new Redis(redisUrl, {
    // Add any specific ioredis options here if needed, e.g., for TLS with self-signed certs (unlikely for Railway)
    // or connection retry strategies, though defaults are usually fine.
    // Example: enableOfflineQueue: false, // to fail fast if not connected initially
  });

  redis.on('error', (err) => {
    console.error('[UltraLowQueue] Redis client error:', err);
    // Potentially set redis to null here to allow re-initialization on next call, or handle more gracefully.
    // For now, it will keep trying to use the errored client.
  });
  
  redis.on('connect', () => {
    console.log('[UltraLowQueue] Redis client connected.');
  });

  return redis;
}

// Enqueue a job (call this to add a job to the queue)
export async function enqueueJob(jobData: any) {
  const client = getRedisClient();
  await client.lpush(QUEUE_KEY, JSON.stringify(jobData));
}

// Process the next job (call this on demand, e.g., via HTTP, cron, or CLI)
export async function processNextJob() {
  const client = getRedisClient();
  const jobStr = await client.rpop(QUEUE_KEY);
  if (jobStr) {
    const job = JSON.parse(jobStr);
    // TODO: Replace this with your actual job processing logic
    console.log('[UltraLowQueue] Processing job:', job);
    // ...process job...
    return job;
  }
  return null;
}

// Optionally, process all jobs in the queue (call this to drain the queue)
export async function processAllJobs() {
  let job;
  // Ensure client is fetched once before loop if processNextJob might be called rapidly
  getRedisClient(); 
  while ((job = await processNextJob())) {
    // Each job is processed in processNextJob()
  }
}

// Example CLI usage (uncomment to use as a script)
// if (require.main === module) {
//   processAllJobs().then(() => {
//     console.log('[UltraLowQueue] All jobs processed.');
//     if (redis) {
//       redis.quit();
//     }
//     process.exit(0);
//   }).catch(err => {
//     console.error('[UltraLowQueue] Error processing jobs:', err);
//     if (redis) {
//       redis.quit();
//     }
//     process.exit(1);
//   });
// } 