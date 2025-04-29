import { Module } from '@nestjs/common';
import { PlatformConnectionsService } from './platform-connections.service';
import { PlatformConnectionsController } from './platform-connections.controller';
// Assuming SupabaseService, EncryptionService are globally provided

@Module({
  controllers: [PlatformConnectionsController],
  providers: [PlatformConnectionsService],
  exports: [PlatformConnectionsService], // Export service for other modules
})
export class PlatformConnectionsModule {} 