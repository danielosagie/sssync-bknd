import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TasksService } from './tasks.service';
import { PlatformConnectionsModule } from '../platform-connections/platform-connections.module';
import { SyncEngineModule } from '../sync-engine/sync-engine.module'; // For InitialSyncService

@Module({
  imports: [
    ScheduleModule, // Not forRoot() here, as it's already in AppModule
    PlatformConnectionsModule, // To provide PlatformConnectionsService
    SyncEngineModule,          // To provide InitialSyncService
  ],
  providers: [TasksService],
})
export class TasksModule {} 