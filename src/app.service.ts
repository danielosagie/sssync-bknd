import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { RedisOptions } from 'ioredis';

@Injectable()
export class AppService implements OnModuleInit {
  private readonly logger = new Logger(AppService.name);

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
    this.logger.log('[AppService] Module Initialized. Testing Redis connection...');
    const redisUrl = this.configService.get<string>('REDIS_URL');
    this.logger.log(`[AppService Redis Test] URL from ConfigService: ${redisUrl}`);

    if (!redisUrl) {
      this.logger.warn('[AppService Redis Test] REDIS_URL not found in config. Skipping direct test.');
      return;
    }

    if (!redisUrl.startsWith('rediss://')) {
        this.logger.warn(`[AppService Redis Test] REDIS_URL does not start with rediss:// (${redisUrl}). TLS might be missing.`);
    }

    try {
      const options: RedisOptions = {
        tls: redisUrl.startsWith('rediss://') ? {} : undefined, // Add TLS options for Upstash
        maxRetriesPerRequest: 3,
        connectTimeout: 10000,
        showFriendlyErrorStack: true,
        lazyConnect: false, // Try connecting immediately
        retryStrategy(times) {
           const delay = Math.min(times * 100, 2000); // Exponential backoff
           this.logger.warn(`[AppService Redis Test] Retrying connection (attempt ${times}), delay ${delay}ms`);
           return delay;
        },
      };
      this.logger.log(`[AppService Redis Test] Attempting connection with options: ${JSON.stringify(options)}`);

      const client = new Redis(redisUrl, options);

      client.on('connect', () => this.logger.log('[AppService Redis Test] Direct client successfully connected!'));
      client.on('ready', () => this.logger.log('[AppService Redis Test] Direct client ready!'));
      client.on('error', (err) => this.logger.error(`[AppService Redis Test] Direct client error: ${err.message}`, err.stack));
      client.on('close', () => this.logger.log('[AppService Redis Test] Direct client connection closed.'));
      client.on('reconnecting', (delay) => this.logger.log(`[AppService Redis Test] Direct client reconnecting in ${delay}ms...`));
      client.on('end', () => this.logger.log('[AppService Redis Test] Direct client connection ended.'));

      // Optional: Ping test after a short delay to ensure connection stability
      // setTimeout(async () => {
      //   try {
      //      const pong = await client.ping();
      //      this.logger.log(`[AppService Redis Test] Ping successful: ${pong}`);
      //      await client.quit(); // Close connection after test
      //   } catch(pingErr) {
      //      this.logger.error(`[AppService Redis Test] Ping failed: ${pingErr.message}`);
      //      await client.quit();
      //   }
      // }, 5000);

    } catch (e) {
      this.logger.error(`[AppService Redis Test] Error during direct client instantiation: ${e.message}`, e.stack);
    }
  }

  getHello(): string {
    return 'Hello World!';
  }
}
