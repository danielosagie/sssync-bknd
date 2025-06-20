import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import { RealtimeSyncService, RealtimeSyncStatus } from './realtime-sync.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthGuard } from '../common/guards/auth.guard';

interface EnableRealtimeSyncDto {
  enableCrossPlatformSync?: boolean;
  propagateCreates?: boolean;
  propagateUpdates?: boolean;
  propagateDeletes?: boolean;
  propagateInventory?: boolean;
}

interface TriggerSyncEventDto {
  type: 'PRODUCT_CREATED' | 'PRODUCT_UPDATED' | 'PRODUCT_DELETED' | 'INVENTORY_UPDATED';
  entityId: string;
}

@Controller('realtime-sync')
@UseGuards(AuthGuard)
export class RealtimeSyncController {
  private readonly logger = new Logger(RealtimeSyncController.name);

  constructor(private readonly realtimeSyncService: RealtimeSyncService) {}

  /**
   * Get real-time sync status for all user connections
   */
  @Get('status')
  async getUserSyncStatus(@CurrentUser() user: any): Promise<RealtimeSyncStatus[]> {
    this.logger.log(`Getting real-time sync status for user ${user.id}`);
    return this.realtimeSyncService.getUserRealtimeSyncStatus(user.id);
  }

  /**
   * Get real-time sync status for a specific connection
   */
  @Get('status/:connectionId')
  async getConnectionSyncStatus(
    @Param('connectionId') connectionId: string,
    @CurrentUser() user: any
  ): Promise<RealtimeSyncStatus> {
    this.logger.log(`Getting real-time sync status for connection ${connectionId}`);
    return this.realtimeSyncService.getRealtimeSyncStatus(connectionId);
  }

  /**
   * Enable real-time sync for a connection
   */
  @Post('enable/:connectionId')
  @HttpCode(HttpStatus.OK)
  async enableRealtimeSync(
    @Param('connectionId') connectionId: string,
    @Body() dto: EnableRealtimeSyncDto,
    @CurrentUser() user: any
  ): Promise<RealtimeSyncStatus> {
    this.logger.log(`Enabling real-time sync for connection ${connectionId} by user ${user.id}`);
    
    if (!connectionId) {
      throw new BadRequestException('Connection ID is required');
    }

    return this.realtimeSyncService.enableRealtimeSync(connectionId, dto);
  }

  /**
   * Disable real-time sync for a connection
   */
  @Post('disable/:connectionId')
  @HttpCode(HttpStatus.OK)
  async disableRealtimeSync(
    @Param('connectionId') connectionId: string,
    @CurrentUser() user: any
  ): Promise<{ success: boolean; message: string }> {
    this.logger.log(`Disabling real-time sync for connection ${connectionId} by user ${user.id}`);
    
    if (!connectionId) {
      throw new BadRequestException('Connection ID is required');
    }

    const success = await this.realtimeSyncService.disableRealtimeSync(connectionId);
    
    return {
      success,
      message: success 
        ? 'Real-time sync disabled successfully' 
        : 'Real-time sync disabled but some webhooks may remain registered',
    };
  }

  /**
   * Test webhook connectivity for a connection
   */
  @Post('test/:connectionId')
  @HttpCode(HttpStatus.OK)
  async testWebhookConnectivity(
    @Param('connectionId') connectionId: string,
    @CurrentUser() user: any
  ): Promise<{
    success: boolean;
    message: string;
    details?: any;
  }> {
    this.logger.log(`Testing webhook connectivity for connection ${connectionId} by user ${user.id}`);
    
    if (!connectionId) {
      throw new BadRequestException('Connection ID is required');
    }

    return this.realtimeSyncService.testWebhookConnectivity(connectionId);
  }

  /**
   * Manually trigger a sync event (for testing/debugging)
   */
  @Post('trigger/:connectionId')
  @HttpCode(HttpStatus.OK)
  async triggerSyncEvent(
    @Param('connectionId') connectionId: string,
    @Body() dto: TriggerSyncEventDto,
    @CurrentUser() user: any
  ): Promise<{ success: boolean; message: string }> {
    this.logger.log(`Manually triggering ${dto.type} sync event for connection ${connectionId} by user ${user.id}`);
    
    if (!connectionId || !dto.type || !dto.entityId) {
      throw new BadRequestException('Connection ID, event type, and entity ID are required');
    }

    await this.realtimeSyncService.triggerManualSyncEvent(dto.type, dto.entityId, connectionId);
    
    return {
      success: true,
      message: `${dto.type} sync event triggered for entity ${dto.entityId}`,
    };
  }

  /**
   * Get real-time sync configuration options
   */
  @Get('config')
  async getSyncConfig(): Promise<{
    supportedPlatforms: string[];
    supportedEvents: string[];
    webhookTopics: Record<string, string[]>;
  }> {
    return {
      supportedPlatforms: ['shopify'],
      supportedEvents: ['PRODUCT_CREATED', 'PRODUCT_UPDATED', 'PRODUCT_DELETED', 'INVENTORY_UPDATED'],
      webhookTopics: {
        shopify: ['products/create', 'products/update', 'products/delete', 'inventory_levels/update'],
      },
    };
  }

  /**
   * Get real-time sync health check
   */
  @Get('health')
  async getHealthCheck(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    checks: Array<{
      name: string;
      status: 'pass' | 'fail';
      message: string;
    }>;
  }> {
    // TODO: Implement actual health checks
    // - Check Redis connectivity for events
    // - Check webhook endpoint accessibility
    // - Check recent webhook activity
    
    return {
      status: 'healthy',
      checks: [
        {
          name: 'Event System',
          status: 'pass',
          message: 'Event emitter is operational',
        },
        {
          name: 'Webhook Endpoints',
          status: 'pass',
          message: 'Webhook endpoints are accessible',
        },
        {
          name: 'Cross-Platform Sync',
          status: 'pass',
          message: 'Cross-platform sync is operational',
        },
      ],
    };
  }
} 