import { Controller, Post, Get, Body, Param, UseGuards, Request, Logger, ParseUUIDPipe } from '@nestjs/common';
import { InitialSyncService, InitialScanResult, MappingSuggestion, SyncPreview } from './initial-sync.service';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { ConfirmMappingsDto } from './dto/confirm-mappings.dto';

@UseGuards(SupabaseAuthGuard)
@Controller('sync') // Base path for sync operations related to connections
export class SyncController {
    private readonly logger = new Logger(SyncController.name);

    constructor(private readonly initialSyncService: InitialSyncService) {}

    // Endpoint called AFTER successful OAuth callback
    @Post('connections/:connectionId/start-scan')
    async startInitialScan(
        @Request() req,
        @Param('connectionId', ParseUUIDPipe) connectionId: string
    ): Promise<{ jobId: string }> {
        const userId = req.user.id;
        this.logger.log(`Request to start initial scan for connection ${connectionId}, user ${userId}`);
        const jobId = await this.initialSyncService.queueInitialScanJob(connectionId, userId);
        return { jobId }; // Return job ID for potential progress tracking
    }

    @Get('connections/:connectionId/scan-summary')
    async getScanSummary(
         @Request() req,
         @Param('connectionId', ParseUUIDPipe) connectionId: string
    ): Promise<InitialScanResult> {
         const userId = req.user.id;
         this.logger.log(`Request for scan summary for connection ${connectionId}, user ${userId}`);
         // TODO: Fetch summary result (potentially stored by InitialScanProcessor)
         return this.initialSyncService.getScanSummary(connectionId, userId);
    }

     @Get('connections/:connectionId/mapping-suggestions')
     async getMappingSuggestions(
         @Request() req,
         @Param('connectionId', ParseUUIDPipe) connectionId: string
     ): Promise<MappingSuggestion[]> {
         const userId = req.user.id;
         // TODO: Fetch suggestions generated during/after scan
         return this.initialSyncService.getMappingSuggestions(connectionId, userId);
     }

     @Post('connections/:connectionId/confirm-mappings')
     async confirmMappings(
         @Request() req,
         @Param('connectionId', ParseUUIDPipe) connectionId: string,
         @Body() confirmationData: ConfirmMappingsDto
     ): Promise<{ success: boolean }> {
         const userId = req.user.id;
         // TODO: Save user choices, update mappings/rules
         await this.initialSyncService.saveConfirmedMappings(connectionId, userId, confirmationData);
         return { success: true };
     }

     @Get('connections/:connectionId/sync-preview')
     async getSyncPreview(
          @Request() req,
          @Param('connectionId', ParseUUIDPipe) connectionId: string
     ): Promise<SyncPreview> {
         const userId = req.user.id;
         // TODO: Generate preview based on confirmed mappings/rules
         return this.initialSyncService.generateSyncPreview(connectionId, userId);
     }

     @Post('connections/:connectionId/activate-sync')
     async activateSync(
          @Request() req,
          @Param('connectionId', ParseUUIDPipe) connectionId: string
     ): Promise<{ jobId: string }> {
         const userId = req.user.id;
         this.logger.log(`Request to activate initial sync for connection ${connectionId}, user ${userId}`);
         // Queue the main initial sync job
         const jobId = await this.initialSyncService.queueInitialSyncJob(connectionId, userId);
         return { jobId };
     }

    // TODO: Endpoint for GET /jobs/:jobId/status ?
} 