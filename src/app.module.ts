import { Module, Global, NestModule, MiddlewareConsumer, RequestMethod, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
// import { BullModule } from '@nestjs/bullmq'; // Assuming BullModule might be unused if all queues via QueueManager
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
// import { PlatformsModule } from './platforms/platforms.module'; // Remove this line
import { ProductsModule } from './products/products.module';
import { UserThrottlerGuard } from './common/guards/user-throttler.guard';

// import { SupabaseService } from './common/supabase.service'; // Provided in CommonModule
// import { EncryptionService } from './common/encryption.service'; // Provided in CommonModule
import { RequestLoggerMiddleware } from './common/middleware/request-logger.middleware';
import { ScheduleModule } from '@nestjs/schedule';
import { TasksModule } from './tasks/tasks.module';
import { PlatformAdaptersModule } from './platform-adapters/platform-adapters.module';
import { BillingModule } from './billing/billing.module';
import { IngestModule } from './ingest/ingest.module';
import { MatchModule } from './match/match.module';
import { BackfillModule } from './sync-engine/backfill.module';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([
      {
            ttl: 60,    // 1 minute
        limit: 60,  // 60 requests per minute (in-memory storage)
      }
    ]),
    CommonModule,
    AuthModule,
    UsersModule,
    // PlatformsModule, // Remove this line
    ProductsModule,
    TasksModule,
    PlatformAdaptersModule,
    BillingModule,
    IngestModule,
    MatchModule,
    BackfillModule,
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
