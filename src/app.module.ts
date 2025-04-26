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
        const redisUrl = configService.get<string>('REDIS_URL');
        if (!redisUrl) {
          console.warn('REDIS_URL not found, Throttler falling back to in-memory storage!');
          return [{
            ttl: configService.get<number>('THROTTLER_TTL', 60000),
            limit: configService.get<number>('THROTTLER_LIMIT', 10),
          }];
        }

        console.log(`Throttler attempting to configure Redis with URL: ${redisUrl.substring(0, redisUrl.indexOf(':'))}://...`);

        const redisOptions = {
          url: redisUrl,
          tls: {},
        };

        return [{
          ttl: configService.get<number>('THROTTLER_TTL', 60000),
          limit: configService.get<number>('THROTTLER_LIMIT', 10),
          storage: new ThrottlerStorageRedisService(redisOptions),
        }];
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
