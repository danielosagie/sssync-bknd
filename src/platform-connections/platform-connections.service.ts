import { Injectable, Logger, NotFoundException, InternalServerErrorException } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service'; // Adjust path
import { EncryptionService } from '../common/encryption.service'; // Adjust path
import { SupabaseClient } from '@supabase/supabase-js';
import { InitialScanResult } from '../sync-engine/initial-sync.service'; // <<< IMPORT TYPE

// Define interface based on your PlatformConnections table in sssync-db.md
export interface PlatformConnection {
  Id: string;
  UserId: string;
  PlatformType: string; // 'shopify', 'square', 'csv', etc.
  DisplayName: string;
  Credentials: any; // Encrypted
  Status: 'connecting' | 'scanning' | 'needs_review' | 'syncing' | 'paused' | 'error' | 'disconnected';
  IsEnabled: boolean;
  LastSyncAttemptAt?: Date | string | null;
  LastSyncSuccessAt?: Date | string | null;
  PlatformSpecificData?: Record<string, any> | null; // e.g., { shop: '...', merchantId: '...' }
  SyncRules?: Record<string, any> | null; // e.g., { syncInventory: true, createNew: false }
  CreatedAt: Date | string;
  UpdatedAt: Date | string;
}

@Injectable()
export class PlatformConnectionsService {
    private readonly logger = new Logger(PlatformConnectionsService.name);

    constructor(
        private readonly supabaseService: SupabaseService,
        private readonly encryptionService: EncryptionService,
    ) {
    }

    // Helper function to get the client or throw - Use service client to bypass RLS
    private getSupabaseClient(): SupabaseClient {
        return this.supabaseService.getServiceClient(); // Use the service_role client to bypass RLS
    }

    async createOrUpdateConnection(
        userId: string,
        platformType: string,
        displayName: string,
        rawCredentials: Record<string, any>, // This is the object
        status: PlatformConnection['Status'],
        platformSpecificData?: Record<string, any>,
    ): Promise<PlatformConnection> {
        const supabase = this.getSupabaseClient(); // Get client here
        let encryptedCredentialsResult: any;
        try {
            // --- FIX ---
            // Pass the rawCredentials OBJECT directly to encrypt
            encryptedCredentialsResult = this.encryptionService.encrypt(rawCredentials);
            // We ASSUME encrypt returns a string suitable for DB storage.
            // If it returns an object/buffer, it needs conversion BEFORE saving.
            if (typeof encryptedCredentialsResult !== 'string') {
                // This might be needed if encrypt returns, e.g., { iv: '...', content: '...' }
                // encryptedCredentialsResult = JSON.stringify(encryptedCredentialsResult);
                this.logger.warn(`Encrypt result is not a string. Storing as is. Type: ${typeof encryptedCredentialsResult}`);
            }
            // --- END FIX ---
        } catch (error) {
             this.logger.error(`Failed to encrypt credentials for ${platformType} user ${userId}: ${error.message}`);
             throw new InternalServerErrorException('Credential processing failed.');
        }

        const connectionData = {
            UserId: userId,
            PlatformType: platformType,
            DisplayName: displayName,
            Credentials: encryptedCredentialsResult, // Store the direct result of encryption
            Status: status,
            IsEnabled: true,
            PlatformSpecificData: platformSpecificData ?? {},
            UpdatedAt: new Date().toISOString(),
        };

        this.logger.log(`Upserting connection for user ${userId}, platform ${platformType}`);
        const { data, error } = await supabase
            .from('PlatformConnections')
            .upsert(connectionData, { onConflict: 'UserId, PlatformType' })
            .select()
            .single();

        if (error || !data) {
            this.logger.error(`Failed to save ${platformType} connection for user ${userId}: ${error?.message}`, error);
            throw new InternalServerErrorException(`Could not save ${platformType} platform connection.`);
        }
        this.logger.log(`Connection ${data.Id} saved/updated for user ${userId}, platform ${platformType}`);
        return data as PlatformConnection;
    }

    async getConnectionById(connectionId: string, userId: string): Promise<PlatformConnection | null> {
         const supabase = this.getSupabaseClient(); // Get client here
         const { data, error } = await supabase
             .from('PlatformConnections')
             .select('*')
             .eq('Id', connectionId)
             .eq('UserId', userId) // Ensure ownership
             .maybeSingle();

         if (error) {
              this.logger.error(`Error fetching connection ${connectionId} for user ${userId}: ${error.message}`);
              throw new InternalServerErrorException('Failed to retrieve connection.');
         }
         return data ? data as PlatformConnection : null;
    }

    async getConnectionsForUser(userId: string): Promise<PlatformConnection[]> {
        const supabase = this.getSupabaseClient(); // Get client here
        // Select only non-sensitive fields for listing
        const { data, error } = await supabase
            .from('PlatformConnections')
            .select('Id, UserId, PlatformType, DisplayName, Status, IsEnabled, LastSyncSuccessAt, CreatedAt, UpdatedAt')
            .eq('UserId', userId)
            .order('CreatedAt', { ascending: false });

        if (error) {
            this.logger.error(`Error fetching connections for user ${userId}: ${error.message}`);
            throw new InternalServerErrorException('Failed to retrieve connections.');
        }
        return (data || []) as PlatformConnection[];
    }

     async updateConnectionStatus(connectionId: string, userId: string, status: PlatformConnection['Status']): Promise<void> {
          await this.updateConnectionData(connectionId, userId, { Status: status });
     }

     async saveSyncRules(connectionId: string, userId: string, rules: Record<string, any>): Promise<void> {
          await this.updateConnectionData(connectionId, userId, { SyncRules: rules });
     }

    async deleteConnection(connectionId: string, userId: string): Promise<void> {
        const supabase = this.getSupabaseClient(); // Get client here
        this.logger.log(`Deleting connection ${connectionId} for user ${userId}`);
        const { error } = await supabase
            .from('PlatformConnections')
            .delete()
            .eq('Id', connectionId)
            .eq('UserId', userId); // Ensure ownership

         if (error) {
              this.logger.error(`Failed to delete connection ${connectionId}: ${error.message}`);
              throw new InternalServerErrorException('Failed to delete connection.');
         }
         // TODO: Optionally revoke token with platform API
    }

    async updateLastSyncSuccess(connectionId: string, userId: string): Promise<void> {
        await this.updateConnectionData(connectionId, userId, { LastSyncSuccessAt: new Date().toISOString() });
    }

    async getDecryptedCredentials(connection: PlatformConnection): Promise<Record<string, any>> {
         const encryptedData = connection.Credentials; // Get raw stored data
         if (!encryptedData) {
            this.logger.error(`Credentials for connection ${connection.Id} are missing.`);
            throw new Error(`Credentials not found for connection ${connection.Id}`);
        }

        try {
            // Assume decrypt EXPECTS the stored data (likely an object from jsonb)
            // And assume it RETURNS the original decrypted *object*
            const decryptedObject = this.encryptionService.decrypt(encryptedData);

            // Remove the check for string type and the JSON.parse call
            // if (typeof decryptedString !== 'string') { ... }
            // return JSON.parse(decryptedString);
            
            // Directly return the object returned by decrypt
            if (typeof decryptedObject !== 'object' || decryptedObject === null) {
                this.logger.error(`Decryption result is not a valid object for connection ${connection.Id}. Type: ${typeof decryptedObject}`);
                throw new Error('Unexpected decryption result type, expected object.');
            }

            return decryptedObject;
        } catch (error) {
            this.logger.error(`Failed to decrypt credentials for connection ${connection.Id}: ${error.message}`);
            // If error is not already an InternalServerErrorException, wrap it
            if (!(error instanceof InternalServerErrorException)) {
                 throw new InternalServerErrorException(`Could not access connection credentials due to decryption error: ${error.message}`);
            }
            throw error; // Re-throw if it's already the correct type
        }
    }

    // --- Methods for Migration Flow ---

    async updateConnectionData(
        connectionId: string,
        userId: string,
        updates: {
            Status?: PlatformConnection['Status'];
            PlatformSpecificData?: Record<string, any>; // For scan results summary?
            SyncRules?: Record<string, any>;
            LastSyncAttemptAt?: Date | string;
            LastSyncSuccessAt?: Date | string;
            IsEnabled?: boolean;
        }
    ): Promise<void> {
        const supabase = this.getSupabaseClient(); // Get client here
        this.logger.log(`Updating data for connection ${connectionId}`, updates);
        const updatePayload = { ...updates, UpdatedAt: new Date().toISOString() };

        // Remove undefined fields to avoid overwriting with null in DB if not intended
        Object.keys(updatePayload).forEach(key => updatePayload[key] === undefined && delete updatePayload[key]);

        const { error } = await supabase
            .from('PlatformConnections')
            .update(updatePayload)
            .eq('Id', connectionId)
            .eq('UserId', userId); // Ensure ownership

        if (error) {
             this.logger.error(`Failed to update data for connection ${connectionId}: ${error.message}`);
             throw new InternalServerErrorException('Failed to update connection data.');
        }
    }

    // Method to potentially store scan summary directly on the connection
    async saveScanSummary(connectionId: string, userId: string, summary: Partial<InitialScanResult>): Promise<void> {
        const connection = await this.getConnectionById(connectionId, userId);
        if (!connection) throw new NotFoundException('Connection not found');
        const currentData = connection.PlatformSpecificData || {};
        const newData = { ...currentData, scanSummary: summary };
        await this.updateConnectionData(connectionId, userId, { PlatformSpecificData: newData });
    }

    async getScanSummaryFromData(connectionId: string, userId: string): Promise<InitialScanResult | null> {
        const connection = await this.getConnectionById(connectionId, userId);
        return connection?.PlatformSpecificData?.['scanSummary'] || null;
    }
} 