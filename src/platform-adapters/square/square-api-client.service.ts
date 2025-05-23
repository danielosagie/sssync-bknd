import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, InternalServerErrorException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosResponse } from 'axios';
import { lastValueFrom } from 'rxjs';
import { PlatformConnection } from 'src/platform-connections/platform-connections.service';
import { EncryptionService } from 'src/common/encryption.service'; // For decrypting credentials
import * as axios from 'axios';
import { randomUUID } from 'crypto';

// --- Square API Interfaces ---

export interface SquareMoney {
  amount: number; // In the smallest currency unit (e.g., cents for USD)
  currency: string; // ISO 4217 currency code (e.g., "USD")
}

export interface SquareLocation {
  id: string;
  name?: string;
  address?: {
    address_line_1?: string;
    address_line_2?: string;
    address_line_3?: string;
    locality?: string; // City
    sublocality?: string;
    administrative_district_level_1?: string; // State/Province
    postal_code?: string;
    country?: string; // ISO 3166-1-alpha-2 country code
  };
  timezone?: string;
  capabilities?: string[]; // e.g., ["CREDIT_CARD_PROCESSING"]
  status?: 'ACTIVE' | 'INACTIVE';
  created_at?: string;
  merchant_id?: string;
  country?: string;
  language_code?: string;
  currency?: string;
  phone_number?: string;
  business_name?: string;
  type?: 'PHYSICAL' | 'MOBILE';
  website_url?: string;
  business_hours?: any; // Can be complex, define if needed
  description?: string;
  // Add other fields as necessary
}

export interface SquareCatalogItemVariation {
  id: string;
  updated_at: string;
  version: number;
  is_deleted: boolean;
  present_at_all_locations: boolean;
  present_at_location_ids?: string[];
  absent_at_location_ids?: string[];
  item_variation_data?: {
    item_id: string; // Parent CatalogItem ID
    name: string;
    sku?: string;
    ordinal: number;
    pricing_type: 'FIXED_PRICING' | 'VARIABLE_PRICING';
    price_money?: SquareMoney;
    location_overrides?: {
      location_id: string;
      price_money?: SquareMoney;
      pricing_type?: 'FIXED_PRICING' | 'VARIABLE_PRICING';
      track_inventory?: boolean;
      inventory_alert_type?: 'NONE' | 'LOW_QUANTITY';
      inventory_alert_threshold?: number;
    }[];
    track_inventory?: boolean;
    inventory_alert_type?: 'NONE' | 'LOW_QUANTITY';
    inventory_alert_threshold?: number;
    user_data?: string;
    service_duration?: number; // Milliseconds
    item_option_values?: {
      item_option_id: string;
      item_option_value_id: string;
    }[];
    // ... other fields like measurement_unit_id
  };
}

export interface SquareCatalogItem {
  id: string;
  updated_at: string;
  version: number;
  is_deleted: boolean;
  present_at_all_locations: boolean;
  present_at_location_ids?: string[];
  absent_at_location_ids?: string[];
  item_data?: {
    name: string;
    description?: string; // Often HTML
    abbreviation?: string;
    is_taxable?: boolean;
    visibility?: string;
    category_id?: string;
    tax_ids?: string[];
    image_ids?: string[]; // Need to fetch images separately if required
    variations: SquareCatalogItemVariation[];
    product_type: 'REGULAR' | 'APPOINTMENTS_SERVICE' | 'GIFT_CARD';
    skip_modifier_screen?: boolean;
    ecom_visibility?: 'VISIBLE' | 'HIDDEN' | 'UNINDEXED';
    item_options?: { item_option_id: string; }[]; // Added to link item options
    // ... other fields like description_plaintext
  };
  type: 'ITEM'; // Ensure this is present to identify it as an item
}

export interface SquareInventoryCount {
  catalog_object_id: string; // ID of the CatalogItemVariation
  catalog_object_type: 'ITEM_VARIATION';
  state: 'IN_STOCK' | 'SOLD' | 'RETURNED_BY_CUSTOMER' | 'RESERVED_FOR_SALE' | 'SOLD_ONLINE' | 'ORDERED_FROM_VENDOR' | 'RECEIVED_FROM_VENDOR' | 'IN_TRANSIT_TO' | 'NONE' | 'WASTE' | 'UNLINKED_RETURN';
  location_id: string;
  quantity: string; // String representation of a number, can be decimal
  calculated_at: string; // ISO 8601 timestamp
  // ... other fields
}

// For the /v2/catalog/list response
interface CatalogListResponse {
  cursor?: string;
  objects?: (SquareCatalogItem | SquareCatalogItemVariation)[]; // And other types like TAX, CATEGORY
  errors?: any[];
}

// For the /v2/inventory/counts/batch-retrieve response
interface InventoryBatchRetrieveResponse {
    cursor?: string;
    counts?: SquareInventoryCount[];
    errors?: any[];
}

// For the /v2/locations response
interface LocationsListResponse {
    locations?: SquareLocation[];
    errors?: any[];
}

// --- Interfaces for Catalog Batch Upsert ---
// Represents a generic catalog object for upserting
export interface SquareCatalogObject {
  type: 'ITEM' | 'ITEM_VARIATION' | 'TAX' | 'DISCOUNT' | 'CATEGORY' | 'MODIFIER_LIST' | 'MODIFIER' | 'IMAGE' | 'ITEM_OPTION' | 'ITEM_OPTION_VAL';
  id: string; // Client-supplied temporary ID, prefixed with #
  version?: number; // For optimistic locking on updates
  present_at_all_locations?: boolean;
  present_at_location_ids?: string[];
  absent_at_location_ids?: string[];
  item_data?: Partial<SquareCatalogItem['item_data']>; // For ITEM type
  item_variation_data?: Partial<SquareCatalogItemVariation['item_variation_data']>; // For ITEM_VARIATION type
  // Add other data types as needed, e.g., category_data, tax_data, image_data
  image_data?: { // For IMAGE type
    name?: string; // Optional: A name for the image
    caption?: string; // Optional: A caption for the image
    // One of the following is required to specify the image source:
    // Option 1: Provide an image URL
    url?: string;
    // Option 2: If you have an image ID from a previous Square upload (e.g., via CreateCatalogImage)
    // image_ids?: string[]; // This seems to be for linking, not creating from ID.
    // For uploading new images as part of batch, Square docs typically point to a multi-step process
    // or using the CreateCatalogImage endpoint first then linking.
    // Let's assume for now we'd have URLs for new images or existing image_ids for linking.
    // However, image creation in batch-upsert is often by providing `id` and then `image_data` with URL.
  };
  item_option_data?: { // For ITEM_OPTION type
    name: string;
    display_name?: string;
    description?: string;
    show_colors?: boolean;
    values?: SquareCatalogObject[]; // Array of ITEM_OPTION_VAL objects
  };
  item_option_value_data?: { // For ITEM_OPTION_VAL type
    name: string;
    description?: string;
    color?: string; // Hex color code like #RRGGBB
    ordinal?: number;
  };
  // Ensure version is omitted for creates, or set to current version for updates
}

export interface SquareCatalogObjectBatch {
  objects: SquareCatalogObject[];
}

export interface SquareBatchUpsertRequest {
  idempotency_key: string;
  batches: SquareCatalogObjectBatch[];
}

export interface SquareIdMapping {
  client_object_id: string; // The temporary ID (e.g., "#foo")
  object_id: string;      // The permanent Square ID (e.g., "J2C5LPL4J5P5W...")
}

export interface SquareBatchUpsertResponse {
  objects?: SquareCatalogObject[]; // The created/updated objects with their permanent IDs
  id_mappings?: SquareIdMapping[];
  errors?: any[]; // Square API errors
  created_at?: string; // Timestamp of the batch operation
}

// --- Interfaces for Catalog Batch Delete ---
export interface SquareBatchDeleteRequest {
  idempotency_key?: string; // Optional, but recommended for batch operations
  object_ids?: string[];
  // For catalog item options and values, you might need to specify their parent item/option if not globally unique
  // However, typically, object_ids are globally unique in Square.
}

export interface SquareBatchDeleteResponse {
  deleted_object_ids?: string[];
  deleted_at?: string; // Timestamp of deletion
  errors?: any[];
}

// --- Interfaces for Inventory Batch Change ---
export interface SquareInventoryChange {
  type: 'PHYSICAL_COUNT' | 'ADJUSTMENT' | 'TRANSFER';
  physical_count?: {
    catalog_object_id: string; // ItemVariation ID
    state: 'IN_STOCK' | 'SOLD' | 'RETURNED_BY_CUSTOMER' | 'RESERVED_FOR_SALE' | 'SOLD_ONLINE' | 'ORDERED_FROM_VENDOR' | 'RECEIVED_FROM_VENDOR' | 'IN_TRANSIT_TO' | 'NONE' | 'WASTE' | 'UNLINKED_RETURN';
    location_id: string;
    quantity: string; // String representation of an integer
    occurred_at?: string; // ISO 8601 timestamp, defaults to now if not set
    employee_id?: string;
  };
  adjustment?: {
    catalog_object_id: string; // ItemVariation ID
    from_state: 'IN_STOCK' | 'SOLD' | 'RETURNED_BY_CUSTOMER' | 'RESERVED_FOR_SALE' | 'SOLD_ONLINE' | 'ORDERED_FROM_VENDOR' | 'RECEIVED_FROM_VENDOR' | 'IN_TRANSIT_TO' | 'NONE' | 'WASTE' | 'UNLINKED_RETURN';
    to_state: 'IN_STOCK' | 'SOLD' | 'RETURNED_BY_CUSTOMER' | 'RESERVED_FOR_SALE' | 'SOLD_ONLINE' | 'ORDERED_FROM_VENDOR' | 'RECEIVED_FROM_VENDOR' | 'IN_TRANSIT_TO' | 'NONE' | 'WASTE' | 'UNLINKED_RETURN';
    location_id: string;
    quantity: string; // String representation of an integer (can be negative for adjustments)
    occurred_at?: string;
    employee_id?: string;
  };
  // Add 'transfer' type if needed
}

export interface SquareBatchChangeInventoryRequest {
  idempotency_key: string;
  changes: SquareInventoryChange[];
  ignore_unchanged_counts?: boolean; // If true, changes resulting in no effective update are ignored
}

export interface SquareBatchChangeInventoryResponse {
  errors?: any[];
  counts?: SquareInventoryCount[]; // Updated inventory counts
}

@Injectable()
export class SquareApiClientService {
  private readonly logger = new Logger(SquareApiClientService.name);
  private readonly baseUrl = 'https://connect.squareup.com/v2';
  private readonly squareVersion = '2023-10-18'; // Use a recent, stable API version

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly encryptionService: EncryptionService,
  ) {}

  private async _getHeaders(connection: PlatformConnection): Promise<Record<string, string>> {
    const encryptedCredentials = connection.Credentials as any; // Assuming it's the encrypted string object {encryptedData: '...'}
    let accessToken: string;

    if (!encryptedCredentials || !encryptedCredentials.encryptedData) {
        this.logger.error(`Encrypted credentials data missing for connection: ${connection.Id}`);
        throw new UnauthorizedException('Credentials are not configured for this Square connection.');
    }
    
    try {
        const decrypted = this.encryptionService.decrypt<{ accessToken: string }>(encryptedCredentials.encryptedData);
        accessToken = decrypted.accessToken;
    } catch (error) {
        this.logger.error(`Failed to decrypt Square credentials for connection ${connection.Id}: ${error.message}`);
        throw new UnauthorizedException('Invalid credentials for Square connection.');
    }

    if (!accessToken) {
      this.logger.error(`Access token not found for Square connection: ${connection.Id}`);
      throw new UnauthorizedException('Square access token is missing.');
    }
    return {
      'Square-Version': this.squareVersion,
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
  }

  async initialize(connection: PlatformConnection): Promise<void> {
        this.logger.log(`Initializing Square API client for connection: ${connection.Id}`);
    // Initialization might involve a test call or just setting up the token for future calls
    try {
        await this._getHeaders(connection); // This will throw if token is bad/missing
        this.logger.log(`Square API client successfully initialized for connection: ${connection.Id}`);
    } catch (error) {
        this.logger.error(`Square API client initialization failed for connection ${connection.Id}: ${error.message}`);
        throw error; // Re-throw the error (likely UnauthorizedException)
    }
  }

  async fetchAllRelevantData(connection: PlatformConnection): Promise<{
    items: SquareCatalogItem[];
    inventoryCounts: SquareInventoryCount[];
    locations: SquareLocation[];
  }> {
    this.logger.log(`Fetching all relevant data from Square for connection ${connection.Id}`);
    
    // Fetch locations first
    const locations = await this._fetchSquareLocations(connection);
    if (!locations || locations.length === 0) {
        this.logger.warn(`No locations found for Square connection ${connection.Id}. Some operations might be affected.`);
        // Depending on strictness, you might throw an error or return early if locations are essential
    }

    // Fetch catalog items and variations
    // The /v2/catalog/list endpoint can return various object types.
    // We request ITEM and ITEM_VARIATION. ITEM objects should contain their variations nested.
    const catalogObjectsResponse = await this._fetchSquareCatalogObjects(connection, ['ITEM']); // Primarily fetch ITEMs
    
    // Filter for items and ensure they have item_data (which contains variations)
    const items = catalogObjectsResponse.filter(
        (obj): obj is SquareCatalogItem => (obj as SquareCatalogItem).type === 'ITEM' && !!(obj as SquareCatalogItem).item_data
    );

    // Extract all variation IDs from the fetched items
    const variationIds = items.reduce((acc, item) => {
      if (item.item_data && item.item_data.variations) {
        item.item_data.variations.forEach(variation => acc.push(variation.id));
      }
      return acc;
    }, [] as string[]);

    // Fetch inventory counts for these variations
    const inventoryCounts = variationIds.length > 0 ? await this._fetchSquareInventory(connection, variationIds, locations.map(l => l.id)) : [];
    
    this.logger.log(`Fetched ${items.length} items, ${inventoryCounts.length} inventory counts, and ${locations.length} locations from Square.`);
    return { items, inventoryCounts, locations };
  }

  public async _fetchSquareCatalogObjects(
    connection: PlatformConnection,
    types: string[], // e.g., ['ITEM', 'ITEM_VARIATION', 'CATEGORY']
  ): Promise<(SquareCatalogItem | SquareCatalogItemVariation)[]> {
    const headers = await this._getHeaders(connection);
    const allObjects: (SquareCatalogItem | SquareCatalogItemVariation)[] = [];
    let cursor: string | undefined = undefined;

    this.logger.debug(`Fetching Square catalog objects of types: ${types.join(', ')}`);

    do {
      const body: { types: string[], cursor?: string, include_related_objects?: boolean } = { types };
      if (cursor) {
        body.cursor = cursor;
      }
      // body.include_related_objects = true; // Optionally include related objects like categories, taxes

      try {
        const response = await lastValueFrom(
          this.httpService.post<CatalogListResponse>(`${this.baseUrl}/catalog/list`, body, { headers }),
        );

        if (response.data.errors) {
          this.logger.error(`Error fetching catalog objects: ${JSON.stringify(response.data.errors)}`);
          throw new InternalServerErrorException('Failed to fetch catalog objects from Square.');
        }

        if (response.data.objects) {
          allObjects.push(...response.data.objects);
        }
        cursor = response.data.cursor;
        this.logger.debug(`Fetched page of catalog objects. Cursor: ${cursor}. Objects on page: ${response.data.objects?.length || 0}`);
      } catch (error: any) {
        this.logger.error(`Failed to fetch Square catalog objects page: ${error.message}`, error.stack);
        if (error.response?.status === 401) throw new UnauthorizedException('Square authentication failed.');
        throw new InternalServerErrorException(`Failed to fetch Square catalog objects: ${error.message}`);
      }
    } while (cursor);

    this.logger.log(`Total Square catalog objects fetched: ${allObjects.length}`);
    return allObjects;
  }

  public async _fetchSquareInventory(
    connection: PlatformConnection,
    catalogObjectIds: string[],
    locationIds: string[], // Can also be empty to fetch for all locations
  ): Promise<SquareInventoryCount[]> {
    if (!catalogObjectIds || catalogObjectIds.length === 0) {
      this.logger.log('No catalog object IDs provided for inventory fetch. Skipping.');
      return [];
    }
    const headers = await this._getHeaders(connection);
    const allInventoryCounts: SquareInventoryCount[] = [];
    let cursor: string | undefined = undefined;

    // Square's batch retrieve inventory counts can take up to 1000 catalog_object_ids.
    // We might need to batch this if catalogObjectIds.length > 1000.
    // For now, assuming it's less. Implement batching if this becomes an issue.
    const MAX_IDS_PER_REQUEST = 1000;
    const idBatches: string[][] = [];
    for (let i = 0; i < catalogObjectIds.length; i += MAX_IDS_PER_REQUEST) {
        idBatches.push(catalogObjectIds.slice(i, i + MAX_IDS_PER_REQUEST));
    }

    this.logger.debug(`Fetching Square inventory for ${catalogObjectIds.length} variation IDs across ${idBatches.length} batches.`);

    for (const idBatch of idBatches) {
        cursor = undefined; // Reset cursor for each new batch of IDs
        do {
            const body: { catalog_object_ids: string[], location_ids?: string[], cursor?: string } = {
            catalog_object_ids: idBatch,
            };
            if (locationIds && locationIds.length > 0) {
            body.location_ids = locationIds;
            }
            if (cursor) {
            body.cursor = cursor;
            }

            try {
            const response = await lastValueFrom(
                this.httpService.post<InventoryBatchRetrieveResponse>(
                `${this.baseUrl}/inventory/counts/batch-retrieve`,
                body,
                { headers },
                ),
            );

            if (response.data.errors) {
                this.logger.error(`Error fetching inventory counts: ${JSON.stringify(response.data.errors)}`);
                throw new InternalServerErrorException('Failed to fetch inventory counts from Square.');
            }

            if (response.data.counts) {
                allInventoryCounts.push(...response.data.counts);
            }
            cursor = response.data.cursor;
            this.logger.debug(`Fetched page of inventory counts. Cursor: ${cursor}. Counts on page: ${response.data.counts?.length || 0}`);
            } catch (error: any) {
            this.logger.error(`Failed to fetch Square inventory counts page: ${error.message}`, error.stack);
            if (error.response?.status === 401) throw new UnauthorizedException('Square authentication failed.');
            throw new InternalServerErrorException(`Failed to fetch Square inventory: ${error.message}`);
            }
        } while (cursor);
    }


    this.logger.log(`Total Square inventory counts fetched: ${allInventoryCounts.length}`);
    return allInventoryCounts;
  }

  public async _fetchSquareLocations(connection: PlatformConnection): Promise<SquareLocation[]> {
    const headers = await this._getHeaders(connection);
    this.logger.debug('Fetching Square locations...');
    try {
      const response = await lastValueFrom(
        this.httpService.get<LocationsListResponse>(`${this.baseUrl}/locations`, { headers }),
      );

      if (response.data.errors) {
        this.logger.error(`Error fetching locations: ${JSON.stringify(response.data.errors)}`);
        throw new InternalServerErrorException('Failed to fetch locations from Square.');
      }
      
      const locations = response.data.locations || [];
      this.logger.log(`Total Square locations fetched: ${locations.length}`);
      return locations;

    } catch (error: any) {
      this.logger.error(`Failed to fetch Square locations: ${error.message}`, error.stack);
      if (error.response?.status === 401) throw new UnauthorizedException('Square authentication failed.');
      throw new InternalServerErrorException(`Failed to fetch Square locations: ${error.message}`);
    }
  }

  // --- Catalog Object Management (Create/Update/Delete) ---

  async batchUpsertCatalogObjects(
    connection: PlatformConnection,
    requestBody: SquareBatchUpsertRequest
  ): Promise<SquareBatchUpsertResponse> {
    const headers = await this._getHeaders(connection);
    const endpoint = `${this.baseUrl}/catalog/batch-upsert`;
    this.logger.debug(`Sending Square batchUpsertCatalogObjects request. Idempotency key: ${requestBody.idempotency_key}, Batches: ${requestBody.batches.length}`);
    // this.logger.verbose(`Square batchUpsertCatalogObjects PAYLOAD: ${JSON.stringify(requestBody, null, 2)}`);

    try {
      const response = await this.httpService.axiosRef.post<SquareBatchUpsertResponse>(endpoint, requestBody, { headers });
      this.logger.log(`Square batchUpsertCatalogObjects successful for idempotency key: ${requestBody.idempotency_key}. Mappings: ${response.data.id_mappings?.length || 0}`);
      if (response.data.errors && response.data.errors.length > 0) {
        this.logger.warn(`Square batchUpsertCatalogObjects for key ${requestBody.idempotency_key} returned with errors: ${JSON.stringify(response.data.errors)}`);
      }
      return response.data;
    } catch (error) {
      this.logger.error(`Error during Square batchUpsertCatalogObjects for key ${requestBody.idempotency_key}: ${error.response?.data ? JSON.stringify(error.response.data) : error.message}`, error.stack);
      if (axios.isAxiosError(error) && error.response) {
        throw new InternalServerErrorException(`Square API Error: ${JSON.stringify(error.response.data)}`);
      }
      throw new InternalServerErrorException(`Failed to batch upsert Square catalog objects: ${error.message}`);
    }
  }

  async batchDeleteCatalogObjects(
    connection: PlatformConnection,
    objectIds: string[]
  ): Promise<SquareBatchDeleteResponse> {
    const headers = await this._getHeaders(connection);
    const endpoint = `${this.baseUrl}/catalog/batch-delete`;
    const idempotencyKey = randomUUID();
    const requestBody: SquareBatchDeleteRequest = {
      idempotency_key: idempotencyKey,
      object_ids: objectIds,
    };

    this.logger.debug(`Sending Square batchDeleteCatalogObjects request. Idempotency key: ${idempotencyKey}, Object IDs: ${objectIds.join(', ')}`);

    try {
      const response = await this.httpService.axiosRef.post<SquareBatchDeleteResponse>(endpoint, requestBody, { headers });
      this.logger.log(`Square batchDeleteCatalogObjects successful for idempotency key: ${idempotencyKey}. Deleted IDs count: ${response.data.deleted_object_ids?.length || 0}`);
      if (response.data.errors && response.data.errors.length > 0) {
        this.logger.warn(`Square batchDeleteCatalogObjects for key ${idempotencyKey} completed with errors: ${JSON.stringify(response.data.errors)}`);
      }
      return response.data;
    } catch (error) {
      this.logger.error(`Error during Square batchDeleteCatalogObjects for key ${idempotencyKey}: ${error.response?.data ? JSON.stringify(error.response.data) : error.message}`, error.stack);
      if (axios.isAxiosError(error) && error.response) {
        // If a 404 is part of the error for some IDs, it might mean they are already deleted.
        // The batch delete response itself will list successfully deleted_object_ids.
        throw new InternalServerErrorException(`Square API Error on batch delete: ${JSON.stringify(error.response.data)}`);
      }
      throw new InternalServerErrorException(`Failed to batch delete Square catalog objects: ${error.message}`);
    }
  }

  async batchChangeInventory(
    connection: PlatformConnection,
    requestBody: SquareBatchChangeInventoryRequest
  ): Promise<SquareBatchChangeInventoryResponse> {
    const headers = await this._getHeaders(connection);
    const endpoint = `${this.baseUrl}/inventory/batch-change`;
    
    this.logger.debug(`Sending Square batchChangeInventory request. Idempotency key: ${requestBody.idempotency_key}, Changes: ${requestBody.changes.length}`);
    // this.logger.verbose(`Square batchChangeInventory PAYLOAD: ${JSON.stringify(requestBody, null, 2)}`);

    try {
      const response = await this.httpService.axiosRef.post<SquareBatchChangeInventoryResponse>(endpoint, requestBody, { headers });
      this.logger.log(`Square batchChangeInventory successful for idempotency key: ${requestBody.idempotency_key}. Updated counts: ${response.data.counts?.length || 0}`);
      if (response.data.errors && response.data.errors.length > 0) {
        this.logger.warn(`Square batchChangeInventory for key ${requestBody.idempotency_key} returned with errors: ${JSON.stringify(response.data.errors)}`);
      }
      return response.data;
    } catch (error) {
      this.logger.error(`Error during Square batchChangeInventory for key ${requestBody.idempotency_key}: ${error.response?.data ? JSON.stringify(error.response.data) : error.message}`, error.stack);
      if (axios.isAxiosError(error) && error.response) {
        throw new InternalServerErrorException(`Square API Error on batch inventory change: ${JSON.stringify(error.response.data)}`);
      }
      throw new InternalServerErrorException(`Failed to batch change Square inventory: ${error.message}`);
    }
  }

  async fetchCatalogObject(
    connection: PlatformConnection,
    objectId: string,
    includeRelatedObjects: boolean = false,
  ): Promise<SquareCatalogItem | SquareCatalogItemVariation | null> { // Can return Item or Variation, or other types
    const headers = await this._getHeaders(connection);
    const endpoint = `${this.baseUrl}/catalog/object/${objectId}`;
    const params: any = {};
    if (includeRelatedObjects) {
      params.include_related_objects = true;
    }

    this.logger.debug(`Fetching Square catalog object ID: ${objectId}, Include Related: ${includeRelatedObjects}`);

    try {
      const response = await this.httpService.axiosRef.get<{ object: any, related_objects?: any[] }>(
        endpoint, 
        { headers, params }
      );
      
      if (response.data && response.data.object) {
        this.logger.log(`Successfully fetched Square catalog object ID: ${objectId}, Type: ${response.data.object.type}`);
        return response.data.object as (SquareCatalogItem | SquareCatalogItemVariation); // Adjust cast as needed
      } else {
        this.logger.warn(`No object data returned when fetching Square catalog object ID: ${objectId}`);
        return null;
      }
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        this.logger.warn(`Square catalog object ID: ${objectId} not found (404).`);
        return null;
      }
      this.logger.error(`Error fetching Square catalog object ID ${objectId}: ${error.response?.data ? JSON.stringify(error.response.data) : error.message}`, error.stack);
      if (axios.isAxiosError(error) && error.response) {
        throw new InternalServerErrorException(`Square API Error fetching object ${objectId}: ${JSON.stringify(error.response.data)}`);
      }
      throw new InternalServerErrorException(`Failed to fetch Square catalog object ${objectId}: ${error.message}`);
    }
  }

  // TODO: Add methods for deleting catalog objects and managing inventory adjustments if needed.
}
