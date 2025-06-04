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

    async createOrUpdateConnection(
        userId: string,
        platformType: string,
        displayName: string,
        rawCredentials: Record<string, any>, // This is the object
        status: PlatformConnection['Status'], // Status for update, new ones will be 'pending'
        platformSpecificData?: Record<string, any>,
    ): Promise<PlatformConnection> {
        const supabase = this.getSupabaseClient();
        let encryptedCredentialsResult: any;
        try {
            encryptedCredentialsResult = this.encryptionService.encrypt(rawCredentials);
            if (typeof encryptedCredentialsResult !== 'string') {
                this.logger.warn(`Encrypt result is not a string. Storing as is. Type: ${typeof encryptedCredentialsResult}`);
            }
        } catch (error) {
             this.logger.error(`Failed to encrypt credentials for ${platformType} user ${userId}: ${error.message}`);
             throw new InternalServerErrorException('Credential processing failed.');
        }

        let existingConnection: PlatformConnection | null = null;

        // For Shopify, try to find an existing connection for this specific shop
        if (platformType.toLowerCase() === 'shopify' && platformSpecificData?.shop) {
            const { data: shopSpecificConnection, error: findError } = await supabase
                .from('PlatformConnections')
                .select('*')
                .eq('UserId', userId)
                .eq('PlatformType', platformType)
                .eq('PlatformSpecificData->>shop', platformSpecificData.shop) // Check specific shop
                .maybeSingle();

            if (findError) {
                this.logger.error(`Error finding shop-specific connection for user ${userId}, shop ${platformSpecificData.shop}: ${findError.message}`);
                // Decide if to throw or log and continue to create (safer to throw if DB error)
                throw new InternalServerErrorException('Error checking for existing shop connection.');
            }
            existingConnection = shopSpecificConnection as PlatformConnection | null;
        } else if (platformType.toLowerCase() !== 'shopify') {
            // For other platforms, use the old onConflict behavior implicitly by trying to find one
            // or implement specific find logic if they also have unique sub-identifiers.
            // For now, this example focuses on Shopify uniqueness.
            // A generic upsert with onConflict on UserId, PlatformType might still be used for them
            // if we decide they can't have multiple instances.
            // To be safe and explicit, let's try a find for non-Shopify too, assuming one per type for now.
             const { data: genericConnection, error: findError } = await supabase
                .from('PlatformConnections')
                .select('*')
                .eq('UserId', userId)
                .eq('PlatformType', platformType)
                .maybeSingle(); // Assuming only one for non-Shopify types for now
            if (findError) {
                this.logger.error(`Error finding generic connection for user ${userId}, platform ${platformType}: ${findError.message}`);
                throw new InternalServerErrorException('Error checking for existing platform connection.');
            }
            existingConnection = genericConnection as PlatformConnection | null;
        }


        if (existingConnection) {
            // Update existing connection
            this.logger.log(`Updating existing connection ${existingConnection.Id} for user ${userId}, platform ${platformType}, shop ${platformSpecificData?.shop || 'N/A'}`);
            const { data, error } = await supabase
                .from('PlatformConnections')
                .update({
                    DisplayName: displayName, // Update display name if it changed
                    Credentials: encryptedCredentialsResult,
                    Status: status, // Use the provided status for updates (e.g. 'active' after re-auth)
                    IsEnabled: true, // Typically re-enable on update/re-auth
                    PlatformSpecificData: { ...existingConnection.PlatformSpecificData, ...platformSpecificData },
                    LastSyncAttemptAt: new Date().toISOString(), // Good to mark an attempt
                    UpdatedAt: new Date().toISOString(),
                })
                .eq('Id', existingConnection.Id)
                .select()
                .single();

            if (error || !data) {
                this.logger.error(`Failed to update connection ${existingConnection.Id}: ${error?.message}`, error);
                throw new InternalServerErrorException(`Could not update ${platformType} platform connection.`);
            }
            this.logger.log(`Connection ${data.Id} updated successfully.`);
            return data as PlatformConnection;
        } else {
            // Create new connection
            this.logger.log(`Creating new connection for user ${userId}, platform ${platformType}, shop ${platformSpecificData?.shop || 'N/A'}`);
            const { data, error } = await supabase
                .from('PlatformConnections')
                .insert({
                    UserId: userId,
                    PlatformType: platformType,
                    DisplayName: displayName,
                    Credentials: encryptedCredentialsResult,
                    Status: 'pending', // Brand new connections start as 'pending'
                    IsEnabled: true,
                    PlatformSpecificData: platformSpecificData ?? {},
                    CreatedAt: new Date().toISOString(), // Set CreatedAt for new records
                    UpdatedAt: new Date().toISOString(),
                })
                .select()
                .single();

            if (error || !data) {
                this.logger.error(`Failed to create new ${platformType} connection for user ${userId}: ${error?.message}`, error);
                throw new InternalServerErrorException(`Could not create new ${platformType} platform connection.`);
            }
            this.logger.log(`New connection ${data.Id} created successfully.`);
            return data as PlatformConnection;
        }
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
} 