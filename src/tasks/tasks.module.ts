import { Module } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { PlatformConnectionsModule } from '../platform-connections/platform-connections.module';
import { SyncEngineModule } from '../sync-engine/sync-engine.module';
import { ManualTasksService } from './manual-tasks.service';
import { TasksController } from './tasks.controller';
import { CommonModule } from '../common/common.module';
import { EmbeddingModule } from '../embedding/embedding.module';

@Module({
  imports: [
    PlatformConnectionsModule,
    SyncEngineModule,
    CommonModule,
    EmbeddingModule,
  ],
  providers: [TasksService, ManualTasksService],
  controllers: [TasksController],
})
export class TasksModule {} 