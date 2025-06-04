import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SupabaseAuthGuard } from './guards/supabase-auth.guard';
import { CommonModule } from '../common/common.module';
import { PlatformConnectionsModule } from '../platform-connections/platform-connections.module';

@Module({
  imports: [
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
      }),
    }),
    CommonModule,
    PlatformConnectionsModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    SupabaseAuthGuard,
  ],
  exports: [
    AuthService,
    SupabaseAuthGuard,
  ]
})
export class AuthModule {}
