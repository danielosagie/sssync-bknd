import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { PlatformsModule } from './platforms/platforms.module';
import { ProductsModule } from './products/products.module';
import { UserThrottlerGuard } from './common/guards/user-throttler.guard';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        storage: new ThrottlerStorageRedisService(configService.get<string>('REDIS_URL')),
        throttlers: [
          {
            name: 'short',
            ttl: parseInt(configService.get<string>('THROTTLE_SHORT_TTL', '1000'), 10),
            limit: parseInt(configService.get<string>('THROTTLE_SHORT_LIMIT', '5'), 10),
          },
          {
            name: 'medium',
            ttl: parseInt(configService.get<string>('THROTTLE_MEDIUM_TTL', '60000'), 10),
            limit: parseInt(configService.get<string>('THROTTLE_MEDIUM_LIMIT', '100'), 10),
          },
          {
            name: 'long',
            ttl: parseInt(configService.get<string>('THROTTLE_LONG_TTL', '3600000'), 10),
            limit: parseInt(configService.get<string>('THROTTLE_LONG_LIMIT', '500'), 10),
          },
        ],
      }),
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
    {
      provide: APP_GUARD,
      useClass: UserThrottlerGuard,
    },
  ],
})
export class AppModule {}
