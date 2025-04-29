import { Controller, Get, Delete, Param, UseGuards, Request, Logger, ParseUUIDPipe, HttpCode, HttpStatus } from '@nestjs/common';
import { PlatformConnectionsService, PlatformConnection } from './platform-connections.service';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard'; // Adjust path

@UseGuards(SupabaseAuthGuard) // Protect all endpoints in this controller
@Controller('platform-connections')
export class PlatformConnectionsController {
    private readonly logger = new Logger(PlatformConnectionsController.name);

    constructor(private readonly connectionsService: PlatformConnectionsService) {}

    @Get()
    async listConnections(@Request() req): Promise<PlatformConnection[]> {
        const userId = req.user.id;
        this.logger.log(`Listing connections for user ${userId}`);
        // Service should return only non-sensitive fields
        return this.connectionsService.getConnectionsForUser(userId);
    }

    @Delete(':id')
    @HttpCode(HttpStatus.NO_CONTENT)
    async deleteConnection(
        @Request() req,
        @Param('id', ParseUUIDPipe) connectionId: string
    ): Promise<void> {
        const userId = req.user.id;
        this.logger.log(`Request to delete connection ${connectionId} for user ${userId}`);
        await this.connectionsService.deleteConnection(connectionId, userId);
    }

    // TODO: Add endpoints for GET /:id (details?), PATCH /:id (update status/rules?)
} 