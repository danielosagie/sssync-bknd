import { Module, Global } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
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
        console.log('[ThrottlerFactory] Starting configuration...');

        const redisUrl = configService.get<string>('REDIS_URL');

        console.log(`[ThrottlerFactory] Read REDIS_URL from ConfigService. Value is: ${redisUrl ? '*** (Exists)' : '!!! NOT FOUND / UNDEFINED !!!'}`);
        if (redisUrl) {
          try {
            const urlObject = new URL(redisUrl);
            console.log(`[ThrottlerFactory] Parsed REDIS_URL - Protocol: ${urlObject.protocol}, Hostname: ${urlObject.hostname}, Port: ${urlObject.port}, Username: ${urlObject.username}`);
          } catch (e) {
            console.error(`[ThrottlerFactory] FAILED TO PARSE REDIS_URL: ${redisUrl}`, e);
          }
        }

        if (!redisUrl) {
          console.warn('[ThrottlerFactory] REDIS_URL is missing or invalid. Throttler falling back to IN-MEMORY storage.');
          return [{
            ttl: configService.get<number>('THROTTLER_TTL', 60000),
            limit: configService.get<number>('THROTTLER_LIMIT', 10),
          }];
        } else {
          console.log('[ThrottlerFactory] REDIS_URL found. Configuring Throttler with Redis storage...');
          const redisOptions = {
            url: redisUrl,
            tls: {},
            maxRetriesPerRequest: 5,
            connectTimeout: 15000,
            showFriendlyErrorStack: true,
            enableReadyCheck: true,
          };

          try {
            const storage = new ThrottlerStorageRedisService(redisOptions);
            console.log('[ThrottlerFactory] ThrottlerStorageRedisService instantiated successfully.');

            return [{
              ttl: configService.get<number>('THROTTLER_TTL', 60000),
              limit: configService.get<number>('THROTTLER_LIMIT', 10),
              storage: storage,
            }];
          } catch (initError) {
            console.error('[ThrottlerFactory] CRITICAL ERROR Instantiating ThrottlerStorageRedisService:', initError);
            console.warn('[ThrottlerFactory] Falling back to IN-MEMORY due to Redis storage init error.');
            return [{ ttl: 60000, limit: 10 }];
          }
        }
      },
    }),
    CommonModule,
    AuthModule,
    UsersModule,
    PlatformsModule,
    ProductsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    SupabaseService,
    EncryptionService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
  exports: [
    SupabaseService,
    EncryptionService,
  ],
})
export class AppModule {}
