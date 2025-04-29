import { Controller, Post, Get, Body, Param, UseGuards, Request, Logger, ParseUUIDPipe, ValidationPipe } from '@nestjs/common'; // Added ValidationPipe
import { InitialSyncService, InitialScanResult, MappingSuggestion, SyncPreview } from './initial-sync.service'; // Check path
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard'; // Check path
import { ConfirmMappingsDto } from './dto/confirm-mappings.dto'; // Check path

@UseGuards(SupabaseAuthGuard)
@Controller('sync')
export class SyncController {
    private readonly logger = new Logger(SyncController.name);

    constructor(private readonly initialSyncService: InitialSyncService) {}

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
         const jobId = await this.initialSyncService.queueInitialSyncJob(connectionId, userId);
         return { jobId };
     }
} 