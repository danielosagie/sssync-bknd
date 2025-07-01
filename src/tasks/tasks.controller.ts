import { Controller, Post, Body, Logger, UseGuards } from '@nestjs/common';
import { ManualTasksService } from './manual-tasks.service';
import { AuthGuard } from '../auth/auth.guard'; // Use existing AuthGuard instead

class BackfillRequestDto {
  businessId: string;
}

@Controller('tasks')
export class TasksController {
  private readonly logger = new Logger(TasksController.name);

  constructor(private readonly manualTasksService: ManualTasksService) {}

  /**
   * Manual backfill endpoint for product embeddings
   */
  @Post('backfill-embeddings')
  @UseGuards(AuthGuard)
  async backfillEmbeddings(@Body() body: { batchSize?: number }) {
    this.logger.log('Starting product embeddings backfill');
    
    const batchSize = body.batchSize || 100;
    await this.manualTasksService.backfillProductEmbeddings(batchSize);
    
    return {
      success: true,
      message: `Product embeddings backfill completed for batch size: ${batchSize}`
    };
  }
} 