import { Module, Global } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SupabaseService } from './supabase.service';
import { EncryptionService } from './encryption.service';
import { ActivityLogService } from './activity-log.service';
import { AiUsageTrackerService } from './ai-usage-tracker.service';

//@Global()
@Module({
  imports: [
    ConfigModule,
    JwtModule.registerAsync({
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('CREDENTIALS_ENCRYPTION_SECRET'),
        signOptions: { expiresIn: '10m' },
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [
    EncryptionService, 
    ActivityLogService,
    AiUsageTrackerService,
    {
      provide: SupabaseService,
      useFactory: async (configService: ConfigService) => {
        const service = new SupabaseService(configService);
        await service.initialize();
        return service;
      },
      inject: [ConfigService],
    },
  ],
  exports: [SupabaseService, EncryptionService, JwtModule, ActivityLogService, AiUsageTrackerService],
})
export class CommonModule {}
