import { Injectable, Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseService } from './supabase.service'; // Adjust path

@Injectable()
export class ActivityLogService {
  private readonly logger = new Logger(ActivityLogService.name);

  constructor(private supabaseService: SupabaseService) {}

  // Helper to safely get client
  private getSupabaseClient(): SupabaseClient | null {
      try {
          return this.supabaseService.getClient();
      } catch (error) {
           this.logger.error(`Failed to get Supabase client for logging: ${error.message}`);
           return null;
      }
  }

  async logActivity(
    userId: string | null, // Allow null for system events
    entityType: string | null,
    entityId: string | null,
    eventType: string, // e.g., 'CREATE_PRODUCT', 'SYNC_PLATFORM_SUCCESS', 'AUTH_FAILURE'
    status: 'Success' | 'Error' | 'Skipped' | 'Info' | 'Warning',
    message: string,
    connectionId?: string | null, // Optional PlatformConnectionId
    platformType?: string | null, // Optional specific platform
    details?: Record<string, any> | null, // Optional JSON details
  ): Promise<void> {
    const supabase = this.getSupabaseClient();
    if (!supabase) {
        this.logger.error(`Supabase client unavailable, skipping activity log: ${eventType} - ${message}`);
        return; // Don't log if DB connection failed
    }

    const logEntry = {
      UserId: userId,
      PlatformConnectionId: connectionId,
      EntityType: entityType,
      EntityId: entityId,
      EventType: eventType,
      Status: status,
      Message: message,
      // Add platformType to details if needed, or consider a dedicated column
      Details: { ...details, ...(platformType && { platform: platformType }) },
      Timestamp: new Date().toISOString(), // Ensure timestamp is set
    };

    const { error } = await supabase.from('ActivityLogs').insert(logEntry);

    if (error) {
      this.logger.error(
        `Failed to insert activity log (${eventType}): ${error.message}`,
        JSON.stringify(logEntry), // Log the entry that failed
      );
    }
  }
}
