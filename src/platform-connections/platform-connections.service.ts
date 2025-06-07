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
  Status: // Updated to lowercase string literals
    | 'active'
    | 'inactive'
    | 'pending'
    | 'needs_review'
    | 'scanning'
    | 'syncing'
    | 'error';
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

    /**
     * If a connection exists for the user with the same platform-specific unique identifier (e.g., Shopify 'shop'),
     * it updates the existing connection's credentials, display name, and status.
     * Otherwise, it creates a new platform connection.
     * 
     * @param userId The ID of the user.
     * @param platformType The type of platform (e.g., 'shopify').
     * @param displayName The display name of the connection.
     * @param rawCredentials The raw credentials for the connection.
     * @param status The status of the connection.
     * @param platformSpecificData Additional data containing unique identifiers (e.g., { shop: '...' } or { merchantId: '...' }).
     * @returns The created or updated PlatformConnection object.
     */
    async createOrUpdateConnection(
        userId: string,
        platformType: string,
        displayName: string,
        rawCredentials: Record<string, any>, // This is the object
        status: PlatformConnection['Status'], // Status for update, new ones will be 'pending'
        platformSpecificData?: Record<string, any>,
    ): Promise<PlatformConnection> {
        const supabase = this.getSupabaseClient();
        const encryptedCredentials = this.encryptionService.encrypt(rawCredentials);

        // Try to find an existing connection based on platform-specific unique identifiers
        const existingConnection = await this.findExistingConnection(userId, platformType, platformSpecificData);

        if (existingConnection) {
            this.logger.log(`Found existing connection ${existingConnection.Id} for user ${userId}, platform ${platformType}. Updating...`);
            // Update the existing connection
            const { data: updatedData, error: updateError } = await supabase
                .from('PlatformConnections')
                .update({
                    DisplayName: displayName,
                    Credentials: encryptedCredentials,
                    Status: status, // Update status (e.g., re-activating a disconnected one)
                    IsEnabled: true, // Always re-enable on update
                    UpdatedAt: new Date().toISOString(),
                })
                .eq('Id', existingConnection.Id)
                .select()
                .single();

            if (updateError) {
                this.logger.error(`Error updating connection ${existingConnection.Id}: ${updateError.message}`);
                throw new InternalServerErrorException('Could not update platform connection.');
            }
            return this.mapRowToConnection(updatedData) as PlatformConnection;

        } else {
            this.logger.log(`No existing connection found for user ${userId}, platform ${platformType} with these specific identifiers. Creating new one...`);
            // Create a new connection
            const { data: newData, error: createError } = await supabase
                .from('PlatformConnections')
                .insert({
                    UserId: userId,
                    PlatformType: platformType,
                    DisplayName: displayName,
                    Credentials: encryptedCredentials,
                    Status: 'pending', // New connections start as 'pending'
                    IsEnabled: true,
                    PlatformSpecificData: platformSpecificData || {},
                })
                .select()
                .single();

            if (createError) {
                this.logger.error(`Error creating new connection for user ${userId}: ${createError.message}`);
                throw new InternalServerErrorException('Could not create platform connection.');
            }
            return this.mapRowToConnection(newData) as PlatformConnection;
        }
    }

    /**
     * Finds an existing connection based on a platform-specific unique key.
     * This method is crucial for preventing duplicate connections for the same store/merchant.
     * It will only return a connection if it finds a match on the unique key (shop or merchantId).
     */
    private async findExistingConnection(
        userId: string,
        platformType: string,
        platformSpecificData?: Record<string, any>
    ): Promise<PlatformConnection | null> {
        const uniqueIdKey = this.getUniqueIdKeyForPlatform(platformType);
        const uniqueIdValue = uniqueIdKey ? platformSpecificData?.[uniqueIdKey] : null;

        // Only proceed if we have a unique identifier to search for.
        if (!uniqueIdKey || !uniqueIdValue) {
            this.logger.debug(`No unique identifier provided for platform type '${platformType}'. Cannot find an existing connection.`);
            return null;
        }

        const supabase = this.getSupabaseClient();
        this.logger.debug(`Searching for existing connection for user ${userId}, platform ${platformType}, with ${uniqueIdKey}: ${uniqueIdValue}`);
        
        const { data, error } = await supabase
            .from('PlatformConnections')
            .select('*')
            .eq('UserId', userId)
            .eq('PlatformType', platformType)
            .eq(`PlatformSpecificData->>${uniqueIdKey}`, uniqueIdValue) // Query the JSONB field
            .maybeSingle();

        if (error) {
            this.logger.error(`Error finding existing connection for ${uniqueIdKey} ${uniqueIdValue}: ${error.message}`);
            return null;
        }

        return data ? (this.mapRowToConnection(data) as PlatformConnection) : null;
    }

    /**
     * Helper to get the JSONB key that uniquely identifies a store/merchant for a given platform.
     */
    private getUniqueIdKeyForPlatform(platformType: string): string | null {
        switch (platformType) {
            case 'shopify':
                return 'shop';
            case 'clover':
            case 'square':
                return 'merchantId';
            default:
                return null;
        }
    }

    async getConnectionById(connectionId: string, userId: string): Promise<PlatformConnection | null> {
        const supabase = this.getSupabaseClient();
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
        return this.mapRowToConnection(data) as PlatformConnection;
    }

    async getConnectionsForUser(userId: string): Promise<PlatformConnection[]> {
        const supabase = this.getSupabaseClient();
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
        return data.map(row => this.mapRowToConnection(row) as PlatformConnection);
    }

    async getAllEnabledConnections(): Promise<PlatformConnection[]> {
        const supabase = this.getSupabaseClient();
        this.logger.log('Fetching all enabled platform connections for periodic tasks.');
        const { data, error } = await supabase
            .from('PlatformConnections')
            .select('Id, UserId, PlatformType, DisplayName, Status, IsEnabled, LastSyncSuccessAt, CreatedAt, UpdatedAt') // Select necessary fields
            .eq('IsEnabled', true);

        if (error) {
            this.logger.error(`Error fetching all enabled connections: ${error.message}`);
            // Depending on severity, you might return [] or throw.
            // For a cron job, perhaps returning [] and logging is better than stopping the whole job.
            return []; 
        }
        return data.map(row => this.mapRowToConnection(row) as PlatformConnection);
    }

     async updateConnectionStatus(connectionId: string, userId: string, status: PlatformConnection['Status']): Promise<void> {
        await this.updateConnectionData(connectionId, userId, { Status: status });
     }

     async saveSyncRules(connectionId: string, userId: string, rules: Record<string, any>): Promise<void> {
        await this.updateConnectionData(connectionId, userId, { SyncRules: rules });
     }

    async disconnectConnection(connectionId: string, userId: string): Promise<void> {
        this.logger.log(`Disconnecting (disabling) connection ${connectionId} for user ${userId}.`);
        await this.updateConnectionData(connectionId, userId, { 
            IsEnabled: false,
            Status: 'inactive' 
        });
        // We are not deleting the record, just marking it as disabled.
        // This preserves mappings and history, and allows for easy reconnection.
    }

    async deleteConnection(connectionId: string, userId: string): Promise<void> {
        const supabase = this.getSupabaseClient();
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
        this.logger.log(`Connection ${connectionId} deleted for user ${userId}.`);
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

    async getConnectionsByPlatformAndAttribute(
        platformType: string,
        attributeKey: string, // e.g., 'shop', 'merchantId'
        attributeValue: string,
    ): Promise<PlatformConnection[]> {
        const supabase = this.getSupabaseClient();
        this.logger.debug(`Fetching connections for platform ${platformType} where PlatformSpecificData.${attributeKey} = ${attributeValue}`);

        // Note: Querying JSONB for a specific key-value pair.
        // The exact syntax might depend on Supabase/PostgreSQL version and how deep the attribute is nested.
        // This assumes attributeKey is a top-level key in PlatformSpecificData.
        // For nested keys, you might use 'PlatformSpecificData->>key1->>key2' or similar.
        const { data, error } = await supabase
            .from('PlatformConnections')
            .select('*')
            .eq('PlatformType', platformType)
            .eq(`PlatformSpecificData->>${attributeKey}`, attributeValue); // Filter by top-level key in JSONB

        if (error) {
            this.logger.error(`Error fetching connections by platform attribute ${platformType}.${attributeKey}=${attributeValue}: ${error.message}`, error.stack);
            throw new InternalServerErrorException(`Could not fetch connections by attribute: ${error.message}`);
        }

        if (!data) {
            this.logger.debug(`No connections found for ${platformType}.${attributeKey}=${attributeValue}`);
            return [];
        }

        return data as PlatformConnection[];
    }

    private mapRowToConnection(row: any): PlatformConnection | null {
        if (!row) return null;
        return {
            Id: row.Id,
            UserId: row.UserId,
            PlatformType: row.PlatformType,
            DisplayName: row.DisplayName,
            Credentials: row.Credentials, // Keep it encrypted here
            Status: row.Status,
            IsEnabled: row.IsEnabled,
            LastSyncAttemptAt: row.LastSyncAttemptAt,
            LastSyncSuccessAt: row.LastSyncSuccessAt,
            PlatformSpecificData: row.PlatformSpecificData,
            SyncRules: row.SyncRules,
            CreatedAt: row.CreatedAt,
            UpdatedAt: row.UpdatedAt,
        };
    }
} 