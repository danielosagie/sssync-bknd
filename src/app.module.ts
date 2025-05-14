import { Module, Global, NestModule, MiddlewareConsumer, RequestMethod, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { BullModule } from '@nestjs/bullmq';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { PlatformsModule } from './platforms/platforms.module';
import { ProductsModule } from './products/products.module';
import { UserThrottlerGuard } from './common/guards/user-throttler.guard';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { SupabaseService } from './common/supabase.service';
import { EncryptionService } from './common/encryption.service';
import { RequestLoggerMiddleware } from './common/middleware/request-logger.middleware';
import { QueueModule } from './queue.module';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const logger = new Logger('ThrottlerFactory');
        logger.log('Starting configuration...');
        const redisUrl = configService.get<string>('REDIS_URL');
        logger.log(`Read REDIS_URL from ConfigService. Value is: ${redisUrl ? '*** (Exists)' : 'Not found'}`);

        if (!redisUrl) {
          logger.warn('REDIS_URL not found. Throttler will use in-memory storage.');
          return [{
            ttl: 60,    // 1 minute
            limit: 60,  // 60 requests per minute (default)
          }];
        }

        try {
          const url = new URL(redisUrl);
          logger.log(`Parsed REDIS_URL - Protocol: ${url.protocol}, Hostname: ${url.hostname}, Port: ${url.port}, Username: ${url.username}`);
        } catch (e) {
          logger.error(`Failed to parse REDIS_URL: ${e.message}`);
          throw new Error ('Invalid REDIS_URL for Throttler configuration');
        }
        
        logger.log('REDIS_URL found. Configuring Throttler with Redis storage...');
        const throttlerStorage = new ThrottlerStorageRedisService(redisUrl);
        logger.log('ThrottlerStorageRedisService instantiated successfully.');

        return [{
          ttl: 60,    // 1 minute
          limit: 60,  // 60 requests per minute
          storage: throttlerStorage,
        }];
      },
    }),
    CommonModule,
    AuthModule,
    UsersModule,
    PlatformsModule,
    ProductsModule,
    QueueModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
  exports: [
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(RequestLoggerMiddleware)
      .forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}
