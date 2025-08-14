import { Controller, Post, Get, Put, Body, Param, UseGuards, Request, Logger, ParseUUIDPipe, ValidationPipe, HttpCode, HttpStatus, NotFoundException, BadRequestException, InternalServerErrorException } from '@nestjs/common'; // Added ValidationPipe and other imports
import { InitialSyncService, InitialScanResult, SyncPreview } from './initial-sync.service'; // Check path
import { MappingSuggestion } from './mapping.service'; // <<< Import from mapping.service
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard'; // Check path
import { ConfirmMappingsDto } from './dto/confirm-mappings.dto'; // Check path
import { PlatformConnectionsService, PlatformConnection } from '../platform-connections/platform-connections.service'; // Added PlatformConnectionsService

@UseGuards(SupabaseAuthGuard)
@Controller('sync')
export class SyncController {
    private readonly logger = new Logger(SyncController.name);

    constructor(
        private readonly initialSyncService: InitialSyncService,
        private readonly platformConnectionsService: PlatformConnectionsService, // Injected PlatformConnectionsService
    ) {}

    @Post('connections/:connectionId/start-scan')
    async startInitialScan(
        @Request() req,
        @Param('connectionId', ParseUUIDPipe) connectionId: string
    ): Promise<{ jobId: string }> {
        const userId = req.user.id;
        this.logger.log(`Request to start initial scan for connection ${connectionId}, user ${userId}`);
        const jobId = await this.initialSyncService.queueInitialScanJob(connectionId, userId);
        return { jobId };
    }

    @Get('connections/:connectionId/scan-summary')
    async getScanSummary(
         @Request() req,
         @Param('connectionId', ParseUUIDPipe) connectionId: string
    ): Promise<InitialScanResult> {
         const userId = req.user.id;
         this.logger.log(`Request for scan summary for connection ${connectionId}, user ${userId}`);
         return this.initialSyncService.getScanSummary(connectionId, userId);
    }

     @Get('connections/:connectionId/mapping-suggestions')
     async getMappingSuggestions(
         @Request() req,
         @Param('connectionId', ParseUUIDPipe) connectionId: string
     ): Promise<MappingSuggestion[]> {
         const userId = req.user.id;
         return this.initialSyncService.getMappingSuggestions(connectionId, userId);
     }

     @Post('connections/:connectionId/confirm-mappings')
     // Add ValidationPipe to validate DTO
     async confirmMappings(
         @Request() req,
         @Param('connectionId', ParseUUIDPipe) connectionId: string,
         @Body(ValidationPipe) confirmationData: ConfirmMappingsDto // Apply ValidationPipe
     ): Promise<{ success: boolean }> {
         const userId = req.user.id;
    await this.initialSyncService.saveConfirmedMappings(connectionId, userId, confirmationData);
    // After saving confirmations, move the connection to needs_review so UI shows the Execute step
    const connection = await this.platformConnectionsService.getConnectionById(connectionId, userId);
    if (connection) {
      await this.platformConnectionsService.updateConnectionStatus(connectionId, userId, 'needs_review');
    }
    return { success: true };
     }

     @Get('connections/:connectionId/sync-preview')
     async getSyncPreview(
          @Request() req,
          @Param('connectionId', ParseUUIDPipe) connectionId: string
     ): Promise<SyncPreview> {
         const userId = req.user.id;
         return this.initialSyncService.generateSyncPreview(connectionId, userId);
     }

     @Post('connections/:connectionId/activate-sync')
     async activateSync(
          @Request() req,
          @Param('connectionId', ParseUUIDPipe) connectionId: string
     ): Promise<{ jobId: string }> {
         const userId = req.user.id;
         this.logger.log(`Request to activate initial sync for connection ${connectionId}, user ${userId}`);
    // Idempotency: if already syncing, return existing job
    const connection = await this.platformConnectionsService.getConnectionById(connectionId, userId);
    if (!connection) throw new NotFoundException('Connection not found');
    const currentJobId = connection.PlatformSpecificData?.currentJobId;
    if (connection.Status === 'syncing' && currentJobId) {
      return { jobId: currentJobId };
    }
    const jobId = await this.initialSyncService.queueInitialSyncJob(connectionId, userId);
    return { jobId };
     }

    @Get('jobs/:jobId/progress')
    async getJobProgress(
      @Request() req,
      @Param('jobId') jobId: string,
    ): Promise<{ isActive: boolean, isCompleted: boolean, isFailed: boolean, progress: number, description: string | null }> {
      // Note: We don't check userId here as jobIds are unique UUIDs and unguessable.
      // A user would only know the job ID if they initiated the action.
      // For higher security, we could store a userId mapping on the job data and verify it.
      this.logger.debug(`Request for progress of job ${jobId}`);
      return this.initialSyncService.getJobProgress(jobId);
    }

  // --- Draft mappings: allow saving and restoring in-progress review state ---
  @Get('connections/:connectionId/draft-mappings')
  async getDraftMappings(
    @Request() req,
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
  ): Promise<{ confirmedMatches: any[]; updatedAt?: string } | { confirmedMatches: []; updatedAt?: string }> {
    const userId = req.user.id;
    const connection = await this.platformConnectionsService.getConnectionById(connectionId, userId);
    if (!connection) {
      throw new NotFoundException(`Connection ${connectionId} not found for user.`);
    }
    const drafts = connection.PlatformSpecificData?.mappingDrafts;
    const confirmations = connection.PlatformSpecificData?.mappingConfirmations;
    if (drafts && Array.isArray(drafts.confirmedMatches)) {
      return { confirmedMatches: drafts.confirmedMatches, updatedAt: drafts.updatedAt };
    }
    if (confirmations && Array.isArray(confirmations.confirmedMatches)) {
      // Fallback to last confirmed set if drafts don't exist
      return { confirmedMatches: confirmations.confirmedMatches, updatedAt: confirmations.confirmedAt };
    }
    return { confirmedMatches: [] };
  }

  @Put('connections/:connectionId/draft-mappings')
  @HttpCode(HttpStatus.NO_CONTENT)
  async saveDraftMappings(
    @Request() req,
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
    @Body(ValidationPipe) draftData: ConfirmMappingsDto,
  ): Promise<void> {
    const userId = req.user.id;
    const connection = await this.platformConnectionsService.getConnectionById(connectionId, userId);
    if (!connection) {
      throw new NotFoundException(`Connection ${connectionId} not found for user.`);
    }
    // Store under PlatformSpecificData.mappingDrafts without triggering any sync operations
    const current = connection.PlatformSpecificData || {};
    const newData = {
      ...current,
      mappingDrafts: {
        confirmedMatches: draftData.confirmedMatches || [],
        updatedAt: new Date().toISOString(),
      },
    };
    await this.platformConnectionsService.updateConnectionData(connectionId, userId, { PlatformSpecificData: newData });
  }

    @Post('connection/:connectionId/reconcile')
    @HttpCode(HttpStatus.ACCEPTED)
    async triggerReconciliation(
        @Request() req,
        @Param('connectionId', ParseUUIDPipe) connectionId: string,
    ): Promise<{ message: string; jobId: string }> {
        const userId = req.user.id;
        this.logger.log(`[POST /sync/connection/${connectionId}/reconcile] User ${userId} requested to trigger reconciliation.`);

        // Fetch connection details to get platformType
        const connection = await this.platformConnectionsService.getConnectionById(connectionId, userId);
        if (!connection) {
            throw new NotFoundException(`Connection with ID ${connectionId} not found for user ${userId}.`);
        }
        if (!connection.IsEnabled) {
            throw new BadRequestException(`Connection with ID ${connectionId} is disabled. Reconciliation cannot be queued.`);
        }
        if (!connection.PlatformType) {
            this.logger.error(`Connection ${connectionId} is missing PlatformType. Cannot queue reconciliation.`);
            throw new InternalServerErrorException(`Connection ${connectionId} is missing PlatformType information.`);
        }

        const jobId = await this.initialSyncService.queueReconciliationJob(connectionId, userId, connection.PlatformType);
        const message = `Reconciliation job successfully queued for connection ${connectionId}. Job ID: ${jobId}`;
        this.logger.log(message);
        return { message, jobId };
     }
} 