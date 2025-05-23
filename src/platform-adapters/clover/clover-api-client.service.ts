import { Injectable, Logger, InternalServerErrorException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlatformConnection, PlatformConnectionsService } from '../../platform-connections/platform-connections.service';
import axios, { AxiosInstance } from 'axios'; // Using axios for HTTP requests
import { CloverProductCreationBundle } from './clover.mapper'; // Import the bundle from the mapper

// --- Define interfaces for Clover API responses ---

// Represents a Clover Location/Address (primarily merchant's main address)
export interface CloverLocation {
    id: string; // This might be the merchant ID itself or a specific address ID if available
    name: string; // Merchant name or location alias
    address?: string;
    city?: string;
    state?: string;
    zip?: string;
    // Clover's concept of "location" for inventory might differ from Shopify.
    // For now, this represents the primary merchant location.
}

// Represents a Clover ItemStock
export interface CloverItemStock {
    item: { id: string };
    stockCount?: number; // Older API versions
    quantity?: number; // Newer API versions might use 'quantity'
    // Potentially other fields like 'quantityOnHand' if available
}

// Represents a Clover Option (e.g., "Red", "Small")
export interface CloverOption {
    id: string;
    name: string;
    attribute: { id: string; name: string }; // Link back to the attribute
}

// Represents a Clover Attribute (e.g., "Color", "Size")
export interface CloverAttribute {
    id: string;
    name: string;
    itemGroup?: { id: string }; // Link to an item group if it's part of one
    options?: { elements: CloverOption[] }; // Nested options
}

// Represents a Clover Variant (often an "Item" in Clover terminology if it has specific options)
// Or a combination of an item with attributes/options
export interface CloverVariant {
    id: string; // The item ID that represents this specific variant
    name: string; // Name of the item, potentially with variant attributes appended
    sku?: string | null;
    price: number; // Price in cents
    priceType?: 'FIXED' | 'VARIABLE' | 'PER_UNIT';
    defaultTaxRates?: boolean;
    cost?: number; // Cost in cents
    itemCode?: string; // Often used for barcode
    // Relationships
    itemGroup?: { id: string }; // If part of an item group (for true variants)
    options?: { elements: CloverOption[] }; // Applied options if this item is a specific variant instance
    // itemStock will be fetched separately or expanded
}

// Represents a Clover Item (can be a product or a variant)
export interface CloverItem {
    id: string;
    hidden: boolean;
    name: string;
    alternateName?: string;
    code?: string; // Often used for SKU or barcode
    sku?: string;
    price: number; // Price in cents
    priceType: 'FIXED' | 'VARIABLE' | 'PER_UNIT';
    defaultTaxRates: boolean;
    cost?: number; // Cost in cents
    isRevenue: boolean;
    modifiedTime: number; // Timestamp
    imageUrl?: string; // <-- ADDED Field for potential image URL
    // Expansions
    categories?: { elements: { id: string; name: string; sortOrder: number }[] };
    tags?: { elements: { id: string; name: string }[] };
    modifierGroups?: { elements: { id: string; name: string; showByDefault?: boolean }[] }; // Modifiers for customizations
    itemStock?: CloverItemStock; // Expanded stock information
    // For items that are part of a variant structure
    itemGroup?: { id: string; name: string; attributes?: { elements: CloverAttribute[] } }; // If this item belongs to a group
    options?: { elements: CloverOption[] }; // If this item itself is a specific variant defined by options
                                            // This might be redundant if itemGroup.attributes.options covers it.
    // variants field if Clover API returns variants directly under a "master" item.
    // The structure suggests variants are often distinct items linked via itemGroups and options.
    variants?: { elements: CloverItem[] }; // If an item can have direct sub-items as variants
}

// Response structure for endpoints that return a list of elements (e.g., items, locations)
export interface CloverListResponse<T> {
    elements: T[];
    href: string; // URL for the current request
    // Clover uses offset and limit, not cursors. Total count isn't always provided.
}

// --- For Creating/Updating Items ---
export interface CloverItemInput {
    name: string;
    price: number; // in cents
    sku?: string | null;
    code?: string | null; // barcode
    cost?: number | null; // in cents
    hidden?: boolean;
    itemGroup?: { id: string }; // To link to an ItemGroup
    // Potentially add other fields like:
    // priceType?: 'FIXED' | 'VARIABLE' | 'PER_UNIT';
    // defaultTaxRates?: boolean;
    // categories?: { elements: { id: string }[] }; // If creating/assigning categories
    // tags?: { elements: { id: string }[] };
}

export interface CloverCreatedItem extends CloverItem { // Extends the existing CloverItem
    // The response from creating an item usually gives back the full item object
}

// --- For Item Groups ---
export interface CloverItemGroupInput {
    name: string;
}

export interface CloverCreatedItemGroup {
    id: string;
    name: string;
}

export interface CloverItemGroup { // Explicitly define and export CloverItemGroup
    id: string;
    name: string;
    items?: { elements: CloverItem[] }; // Optional based on expansion
    attributes?: { elements: CloverAttribute[] }; // Optional based on expansion
}

// --- For Attributes ---
export interface CloverAttributeInput {
    name: string;
    itemGroup: { id: string }; // Link to item group
}

export interface CloverCreatedAttribute {
    id: string;
    name: string;
    itemGroup: { id: string };
}

// --- For Options ---
export interface CloverOptionInput {
    name: string;
}

export interface CloverCreatedOption {
    id: string;
    name: string;
    attribute: { id: string }; // Link back to attribute
}

// --- For Option-Item Associations ---
export interface CloverOptionItemAssociation {
    option: { id: string };
    item: { id: string };
}

export interface CloverOptionItemAssociationInput {
    elements: CloverOptionItemAssociation[];
}

// Response for Option-Item association is usually a success/failure, not a complex object.

// --- Response for the orchestrator ---
export interface CreateCloverProductResponse {
    success: boolean; // Overall success indicator
    message?: string; // Overall message
    itemGroupId?: string;
    itemGroupError?: string;
    createdAttributes: Array<{ originalName: string; id?: string; error?: string; options: Array<{ originalName: string; id?: string; error?: string }> }>;
    variantItemResponses: Array<{
        canonicalVariantId: string;
        cloverItemId?: string;
        cloverItemSku?: string | null;
        success: boolean;
        error?: string;
        optionAssociationError?: string;
    }>;
}

@Injectable()
export class CloverApiClient {
    private readonly logger = new Logger(CloverApiClient.name);
    public axiosInstance: AxiosInstance;
    private cloverApiBaseUrl: string;

    constructor(
        private readonly configService: ConfigService,
        private readonly connectionsService: PlatformConnectionsService,
    ) {
        this.cloverApiBaseUrl = this.configService.get<string>('CLOVER_API_BASE_URL', 'https://sandbox.dev.clover.com'); // Default to sandbox
        this.axiosInstance = axios.create({
            baseURL: this.cloverApiBaseUrl,
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
            },
        });

        this.axiosInstance.interceptors.request.use(request => {
            this.logger.debug(`[Clover API Request] ${request.method?.toUpperCase()} ${request.url}`);
            // this.logger.debug(`[Clover API Request Headers] ${JSON.stringify(request.headers)}`);
            if (request.data) {
                this.logger.debug(`[Clover API Request Body] ${JSON.stringify(request.data)}`);
            }
            return request;
        });
        this.axiosInstance.interceptors.response.use(response => {
            this.logger.debug(`[Clover API Response] Status: ${response.status} for ${response.config.method?.toUpperCase()} ${response.config.url}`);
            // this.logger.debug(`[Clover API Response Data] ${JSON.stringify(response.data)}`);
            return response;
        }, error => {
            this.logger.error(`[Clover API Error] Status: ${error.response?.status} for ${error.config?.method?.toUpperCase()} ${error.config?.url}`);
            if (error.response?.data) {
                this.logger.error(`[Clover API Error Data] ${JSON.stringify(error.response.data)}`);
            } else {
                this.logger.error(`[Clover API Error Message] ${error.message}`);
            }
            return Promise.reject(error);
        });
    }

    public async getHeaders(connection: PlatformConnection): Promise<{ Authorization: string }> {
        let credentials;
        try {
            credentials = await this.connectionsService.getDecryptedCredentials(connection);
            if (!credentials?.accessToken) {
                throw new Error('Decrypted credentials missing accessToken.');
            }
        } catch (error) {
            this.logger.error(`Failed to get/decrypt credentials for Clover connection ${connection.Id}: ${error.message}`);
            throw new UnauthorizedException(`Could not access credentials for Clover connection ${connection.Id}. Please reconnect.`);
        }
        return { Authorization: `Bearer ${credentials.accessToken}` };
    }

    private async _fetchWithPagination<T>(
        connection: PlatformConnection,
        merchantId: string,
        endpoint: string, // e.g., `/v3/merchants/${merchantId}/items`
        expandFields?: string[], // e.g., ['itemStock', 'variants']
        initialParams: Record<string, any> = {}
    ): Promise<T[]> {
        const allElements: T[] = [];
        let offset = 0;
        const limit = 100; // Max limit for many Clover endpoints, some might be 1000, adjust if needed
        let keepFetching = true;
        const headers = await this.getHeaders(connection);

        this.logger.debug(`Starting paginated fetch for endpoint: ${endpoint} with merchantId: ${merchantId}`);

        while (keepFetching) {
            const params: Record<string, any> = {
                ...initialParams,
                limit,
                offset,
            };
            if (expandFields && expandFields.length > 0) {
                params['expand'] = expandFields.join(',');
            }

            try {
                this.logger.debug(`Fetching page with offset ${offset}, limit ${limit}, params: ${JSON.stringify(params)}`);
                const response = await this.axiosInstance.get<CloverListResponse<T>>(endpoint, { headers, params });
                
                if (response.data && response.data.elements) {
                    allElements.push(...response.data.elements);
                    if (response.data.elements.length < limit) {
                        keepFetching = false; // Last page
                    } else {
                        offset += limit;
                    }
                } else {
                    this.logger.warn(`No elements found in response for ${endpoint} at offset ${offset}. Response: ${JSON.stringify(response.data)}`);
                    keepFetching = false;
                }
            } catch (error) {
                this.logger.error(`Error fetching page for ${endpoint} at offset ${offset}: ${error.message}`, error.stack);
                if (axios.isAxiosError(error) && error.response?.status === 401) {
                    await this.connectionsService.updateConnectionStatus(connection.Id, connection.UserId, 'error');
                    throw new UnauthorizedException(`Clover authentication failed. Please reconnect the Clover account.`);
                }
                // Decide if one page failure should stop all, for now, it does.
                throw new InternalServerErrorException(`Failed to fetch data from Clover: ${error.message}`);
            }
        }
        this.logger.log(`Finished paginated fetch for ${endpoint}. Total elements fetched: ${allElements.length}`);
        return allElements;
    }


    // Placeholder for the main data fetching method
    async fetchAllRelevantData(connection: PlatformConnection): Promise<{
        items: CloverItem[];
        // variants: CloverVariant[]; // Variants might be derived from items with options
        locations: CloverLocation[]; // For now, this will likely be the single merchant location
        itemStocks: CloverItemStock[]; // If fetched separately
    }> {
        const merchantId = connection.PlatformSpecificData?.merchantId;
        if (!merchantId) {
            this.logger.error(`Merchant ID not found in PlatformSpecificData for connection ${connection.Id}`);
            throw new InternalServerErrorException('Clover merchantId is missing for this connection.');
        }
        this.logger.log(`Starting to fetch all relevant data for Clover merchant: ${merchantId}`);

        // 1. Fetch Locations (Merchant Address for now)
        // This is a simplified approach; Clover's locations are typically just the merchant's address.
        // If a merchant has multiple physical stores under one mId with separate inventory, API needs deeper check.
        let cloverLocations: CloverLocation[] = [];
        try {
            const headers = await this.getHeaders(connection);
            const merchantDetailsResponse = await this.axiosInstance.get<{ id: string; name: string; address?: { address1: string; city: string; state: string; zip: string} }>(
                `/v3/merchants/${merchantId}`, 
                { headers, params: { expand: 'address' } }
            );
            if (merchantDetailsResponse.data) {
                const md = merchantDetailsResponse.data;
                cloverLocations.push({
                    id: md.id, // Use merchant ID as the location ID for now
                    name: md.name,
                    address: md.address?.address1,
                    city: md.address?.city,
                    state: md.address?.state,
                    zip: md.address?.zip,
                });
            }
             this.logger.log(`Fetched merchant details as location: ${JSON.stringify(cloverLocations)}`);
        } catch (error) {
            this.logger.error(`Failed to fetch merchant details for Clover merchant ${merchantId}: ${error.message}`, error.stack);
            // Continue if merchant details fail, but log it; items/inventory are more critical.
        }


        // 2. Fetch All Items with expansions
        const expandItemFields = ['itemStock', 'categories', 'tags', 'modifierGroups', 'itemGroup', 'options', 'variants'];
        // The 'variants' expansion on /items might give direct variant sub-items.
        // 'itemGroup' and 'options' help identify items that are themselves variants.
        
        const allItems = await this._fetchWithPagination<CloverItem>(
            connection,
            merchantId,
            `/v3/merchants/${merchantId}/items`,
            expandItemFields
        );

        this.logger.log(`Total Clover items fetched: ${allItems.length}`);
        
        // ItemStocks are typically expanded directly onto items if `expand=itemStock` is used.
        // If not, or if we need to fetch them separately for some reason:
        // const allItemStocks = await this._fetchWithPagination<CloverItemStock>(
        //    connection, merchantId, `/v3/merchants/${merchantId}/item_stocks`
        // );
        // For now, assume itemStock expansion is sufficient.

        return {
            items: allItems,
            locations: cloverLocations,
            itemStocks: [], // Assuming itemStock is expanded on items. If not, populate from allItemStocks.
        };
    }

    initialize(connection: PlatformConnection): void {
        this.logger.log(`Clover API Client Initialized for connection: ${connection.Id}. Base URL: ${this.cloverApiBaseUrl}`);
        // Actual token setting is done per-request in getHeaders()
    }

    // --- Product Creation Orchestration & Helpers ---

    private async _createItemGroup(connection: PlatformConnection, merchantId: string, payload: CloverItemGroupInput): Promise<CloverCreatedItemGroup> {
        const headers = await this.getHeaders(connection);
        const endpoint = `/v3/merchants/${merchantId}/item_groups`;
        this.logger.debug(`Creating item group for mId ${merchantId} with payload: ${JSON.stringify(payload)}`);
        try {
            const response = await this.axiosInstance.post<CloverCreatedItemGroup>(endpoint, payload, { headers });
            this.logger.log(`Successfully created item group ID: ${response.data.id} for mId ${merchantId}`);
            return response.data;
        } catch (error) {
            const errorMsg = `Failed to create item group for mId ${merchantId}: ${error.response?.data?.message || error.message}`;
            this.logger.error(errorMsg, error.stack);
            throw new InternalServerErrorException(errorMsg);
        }
    }

    private async _createAttribute(connection: PlatformConnection, merchantId: string, payload: CloverAttributeInput): Promise<CloverCreatedAttribute> {
        const headers = await this.getHeaders(connection);
        const endpoint = `/v3/merchants/${merchantId}/attributes`;
        this.logger.debug(`Creating attribute for mId ${merchantId}, itemGroupId ${payload.itemGroup.id} with payload: ${JSON.stringify(payload)}`);
        try {
            const response = await this.axiosInstance.post<CloverCreatedAttribute>(endpoint, payload, { headers });
            this.logger.log(`Successfully created attribute ID: ${response.data.id} for item group ${payload.itemGroup.id}`);
            return response.data;
        } catch (error) {
            const errorMsg = `Failed to create attribute for item group ${payload.itemGroup.id}: ${error.response?.data?.message || error.message}`;
            this.logger.error(errorMsg, error.stack);
            throw new InternalServerErrorException(errorMsg);
        }
    }

    private async _createOption(connection: PlatformConnection, merchantId: string, attributeId: string, payload: CloverOptionInput): Promise<CloverCreatedOption> {
        const headers = await this.getHeaders(connection);
        const endpoint = `/v3/merchants/${merchantId}/attributes/${attributeId}/options`;
        this.logger.debug(`Creating option for mId ${merchantId}, attributeId ${attributeId} with payload: ${JSON.stringify(payload)}`);
        try {
            const response = await this.axiosInstance.post<CloverCreatedOption>(endpoint, payload, { headers });
            this.logger.log(`Successfully created option ID: ${response.data.id} for attribute ${attributeId}`);
            return response.data;
        } catch (error) {
            const errorMsg = `Failed to create option for attribute ${attributeId}: ${error.response?.data?.message || error.message}`;
            this.logger.error(errorMsg, error.stack);
            throw new InternalServerErrorException(errorMsg);
        }
    }

    private async _createCloverItem(connection: PlatformConnection, merchantId: string, payload: CloverItemInput): Promise<CloverCreatedItem> {
        const headers = await this.getHeaders(connection);
        const endpoint = `/v3/merchants/${merchantId}/items`;
        this.logger.debug(`Creating item for mId ${merchantId} with payload: ${JSON.stringify(payload)}`);
        try {
            const response = await this.axiosInstance.post<CloverCreatedItem>(endpoint, payload, { headers });
            this.logger.log(`Successfully created item ID: ${response.data.id} for mId ${merchantId}`);
            return response.data;
        } catch (error) {
            const errorMsg = `Failed to create item (variant) "${payload.name}": ${error.response?.data?.message || error.message}`;
            this.logger.error(errorMsg, error.stack);
            throw new InternalServerErrorException(errorMsg);
        }
    }

    private async _associateOptionsWithItem(connection: PlatformConnection, merchantId: string, associations: CloverOptionItemAssociation[]): Promise<void> {
        if (!associations || associations.length === 0) {
            this.logger.debug('No option-item associations to create.');
            return;
        }
        const headers = await this.getHeaders(connection);
        const endpoint = `/v3/merchants/${merchantId}/option_items`;
        const payload: CloverOptionItemAssociationInput = { elements: associations };
        this.logger.debug(`Associating options with item(s) for mId ${merchantId} with payload: ${JSON.stringify(payload)}`);
        try {
            await this.axiosInstance.post(endpoint, payload, { headers });
            this.logger.log(`Successfully created ${associations.length} option-item associations for mId ${merchantId}. First item ID: ${associations[0]?.item?.id}`);
        } catch (error) {
            const errorMsg = `Failed to associate options with items: ${error.response?.data?.message || error.message}`;
            this.logger.error(errorMsg, error.stack);
            throw new InternalServerErrorException(errorMsg);
        }
    }
    
    async orchestrateCloverProductCreation(
        connection: PlatformConnection,
        bundle: CloverProductCreationBundle,
    ): Promise<CreateCloverProductResponse> {
        const merchantId = connection.PlatformSpecificData?.merchantId;
        if (!merchantId) {
            this.logger.error(`Merchant ID not found in PlatformSpecificData for connection ${connection.Id}`);
            return { 
                success: false, 
                message: 'Clover merchantId is missing for this connection.',
                createdAttributes: [],
                variantItemResponses: [] 
            };
        }

        this.logger.log(`Orchestrating Clover product creation for mId ${merchantId}, product title: ${bundle.itemGroupPayload.name}`);
        const overallResponse: CreateCloverProductResponse = {
            success: false, // Will be true if item group and at least one variant item + associations succeed
            createdAttributes: [],
            variantItemResponses: [],
        };

        let createdItemGroup: CloverCreatedItemGroup | null = null;
        try {
            createdItemGroup = await this._createItemGroup(connection, merchantId, bundle.itemGroupPayload);
            overallResponse.itemGroupId = createdItemGroup.id;
            this.logger.log(`Item group "${createdItemGroup.name}" (ID: ${createdItemGroup.id}) created successfully.`);
        } catch (error) {
            overallResponse.itemGroupError = error.message;
            this.logger.error(`Failed to create item group "${bundle.itemGroupPayload.name}": ${error.message}`);
            // If item group creation fails, we cannot proceed with attributes or items linked to it.
            overallResponse.message = `Failed to create base item group: ${error.message}`;
            return overallResponse;
        }

        // Map to store created option IDs: Map<OriginalAttributeName, Map<OriginalOptionName, CloverOptionID>>
        const createdCloverOptionIdsMap = new Map<string, Map<string, string>>();

        for (const attrPayload of bundle.attributesPayload) {
            const attributeResponse: CreateCloverProductResponse['createdAttributes'][0] = {
                originalName: attrPayload.originalOptionName, // This was original attribute name
                options: [],
            };
            try {
                const attributeInputWithGroup: CloverAttributeInput = {
                    ...attrPayload.attribute,
                    itemGroup: { id: createdItemGroup.id },
                };
                const createdAttribute = await this._createAttribute(connection, merchantId, attributeInputWithGroup);
                attributeResponse.id = createdAttribute.id;
                createdCloverOptionIdsMap.set(attrPayload.originalOptionName, new Map());

                for (const optPayload of attrPayload.options) {
                    const optionResponse: typeof attributeResponse.options[0] = { originalName: optPayload.name };
                    try {
                        const createdOption = await this._createOption(connection, merchantId, createdAttribute.id, optPayload);
                        optionResponse.id = createdOption.id;
                        createdCloverOptionIdsMap.get(attrPayload.originalOptionName)!.set(optPayload.name, createdOption.id);
                    } catch (optError) {
                        optionResponse.error = optError.message;
                        this.logger.warn(`Failed to create option "${optPayload.name}" for attribute "${attrPayload.originalOptionName}": ${optError.message}`);
                    }
                    attributeResponse.options.push(optionResponse);
                }
            } catch (attrError) {
                attributeResponse.error = attrError.message;
                this.logger.warn(`Failed to create attribute "${attrPayload.originalOptionName}": ${attrError.message}`);
            }
            overallResponse.createdAttributes.push(attributeResponse);
        }
        
        let atLeastOneVariantSucceeded = false;

        for (const variantPayload of bundle.variantItemPayloads) {
            const variantResponse: CreateCloverProductResponse['variantItemResponses'][0] = {
                canonicalVariantId: variantPayload.canonicalVariantId,
                success: false,
            };
            try {
                const itemInputWithGroup: CloverItemInput = {
                    ...variantPayload.itemInput,
                    itemGroup: { id: createdItemGroup.id },
                };
                const createdCloverItem = await this._createCloverItem(connection, merchantId, itemInputWithGroup);
                variantResponse.cloverItemId = createdCloverItem.id;
                variantResponse.cloverItemSku = createdCloverItem.sku || createdCloverItem.code;
                variantResponse.success = true; // Mark item creation as success initially
                atLeastOneVariantSucceeded = true; // If one item creates, product is partially there

                // Now associate options
                const associations: CloverOptionItemAssociation[] = [];
                if (variantPayload.selectedOptions && variantPayload.selectedOptions.length > 0) {
                    for (const selectedOpt of variantPayload.selectedOptions) {
                        const cloverOptionId = createdCloverOptionIdsMap.get(selectedOpt.attributeName)?.get(selectedOpt.optionName);
                        if (cloverOptionId) {
                            associations.push({
                                option: { id: cloverOptionId },
                                item: { id: createdCloverItem.id },
                            });
                        } else {
                            this.logger.warn(`Could not find created Clover Option ID for attribute "${selectedOpt.attributeName}", option "${selectedOpt.optionName}" for item ${createdCloverItem.id}`);
                        }
                    }
                }

                if (associations.length > 0) {
                    try {
                        await this._associateOptionsWithItem(connection, merchantId, associations);
                        this.logger.log(`Successfully associated ${associations.length} options for Clover item ID ${createdCloverItem.id}.`);
                    } catch (assocError) {
                        variantResponse.optionAssociationError = assocError.message;
                        variantResponse.success = false; // Overall success for this variant is now false
                        atLeastOneVariantSucceeded = overallResponse.variantItemResponses.some(vr => vr.success); // re-evaluate
                        this.logger.error(`Failed to associate options for Clover item ID ${createdCloverItem.id}: ${assocError.message}`);
                    }
                } else if (variantPayload.selectedOptions && variantPayload.selectedOptions.length > 0) {
                    // This means there were selected options in the canonical data, but we couldn't map them to created Clover options
                    variantResponse.optionAssociationError = "Could not map all canonical options to created Clover options for association.";
                    variantResponse.success = false;
                     atLeastOneVariantSucceeded = overallResponse.variantItemResponses.some(vr => vr.success);
                    this.logger.warn(`Item ${createdCloverItem.id} had selected options, but no valid Clover option IDs found for association.`);
                }

            } catch (itemError) {
                variantResponse.error = itemError.message;
                variantResponse.success = false;
                this.logger.error(`Failed to create Clover item for canonical variant ID ${variantPayload.canonicalVariantId}: ${itemError.message}`);
            }
            overallResponse.variantItemResponses.push(variantResponse);
        }

        overallResponse.success = !!overallResponse.itemGroupId && atLeastOneVariantSucceeded;
        if (overallResponse.success) {
            overallResponse.message = `Product structure partially or fully created on Clover for ${bundle.itemGroupPayload.name}.`;
        } else if (overallResponse.itemGroupId && !atLeastOneVariantSucceeded) {
            overallResponse.message = `Item group created (ID: ${overallResponse.itemGroupId}), but all variant item creations failed for ${bundle.itemGroupPayload.name}.`;
        } else {
            overallResponse.message = `Failed to create product structure on Clover for ${bundle.itemGroupPayload.name}. See errors for details.`;
        }

        this.logger.log(`Clover product creation orchestration finished for mId ${merchantId}, product: ${bundle.itemGroupPayload.name}. Overall Success: ${overallResponse.success}`);
        return overallResponse;
    }

    // --- Item Deletion ---
    async deleteCloverItem(connection: PlatformConnection, merchantId: string, itemId: string): Promise<void> {
        const headers = await this.getHeaders(connection);
        const endpoint = `/v3/merchants/${merchantId}/items/${itemId}`;
        this.logger.log(`Attempting to delete Clover item ID: ${itemId} for merchant: ${merchantId}`);
        try {
            const response = await this.axiosInstance.delete(endpoint, { headers });
            // Clover delete item returns 200 OK with potentially an object like { "id": "ITEMID", "object": "item", "deleted": true } or 204 No Content
            if (response.status === 200 || response.status === 204) {
                 this.logger.log(`Successfully deleted Clover item ID: ${itemId} for merchant: ${merchantId}. Status: ${response.status}`);
            } else {
                // Should be caught by axios interceptor, but good to have specific log here if status is unexpected but not error code
                this.logger.warn(`Clover item deletion for ID ${itemId} returned status ${response.status}, expected 200 or 204.`);
            }
        } catch (error) {
            const errorMsg = `Failed to delete Clover item ID ${itemId}: ${error.response?.data?.message || error.message}`;
            this.logger.error(errorMsg, error.stack);
            // Check if it's a 404, meaning already deleted, which could be considered a success for a delete operation.
            if (axios.isAxiosError(error) && error.response?.status === 404) {
                this.logger.warn(`Clover item ID ${itemId} not found (404). Assuming already deleted.`);
                return; // Treat as success
            }
            throw new InternalServerErrorException(errorMsg);
        }
    }

    async deleteCloverItemGroup(connection: PlatformConnection, merchantId: string, itemGroupId: string): Promise<void> {
        const headers = await this.getHeaders(connection);
        const endpoint = `/v3/merchants/${merchantId}/item_groups/${itemGroupId}`;
        this.logger.log(`Attempting to delete Clover item group ID: ${itemGroupId} for merchant: ${merchantId}`);
        try {
            const response = await this.axiosInstance.delete(endpoint, { headers });
            if (response.status === 200 || response.status === 204) {
                 this.logger.log(`Successfully deleted Clover item group ID: ${itemGroupId} for merchant: ${merchantId}. Status: ${response.status}`);
            } else {
                 this.logger.warn(`Clover item group deletion for ID ${itemGroupId} returned status ${response.status}, expected 200 or 204.`);
            }
        } catch (error) {
            const errorMsg = `Failed to delete Clover item group ID ${itemGroupId}: ${error.response?.data?.message || error.message}`;
            this.logger.error(errorMsg, error.stack);
            if (axios.isAxiosError(error) && error.response?.status === 404) {
                this.logger.warn(`Clover item group ID ${itemGroupId} not found (404). Assuming already deleted.`);
                return; // Treat as success
            }
            // Note: Clover might prevent deletion of non-empty item groups. This would result in an error (e.g., 400 or 409).
            // The orchestrator (adapter) should decide if it needs to delete items first.
            throw new InternalServerErrorException(errorMsg);
        }
    }

    // --- Item Group Update ---
    async updateCloverItemGroup(connection: PlatformConnection, merchantId: string, itemGroupId: string, payload: Partial<CloverItemGroupInput>): Promise<CloverCreatedItemGroup> {
        const headers = await this.getHeaders(connection);
        const endpoint = `/v3/merchants/${merchantId}/item_groups/${itemGroupId}`;
        this.logger.log(`Attempting to update Clover item group ID: ${itemGroupId} for merchant: ${merchantId} with payload: ${JSON.stringify(payload)}`);
        try {
            // Clover uses POST for updates on item_groups, not PUT/PATCH typically
            const response = await this.axiosInstance.post<CloverCreatedItemGroup>(endpoint, payload, { headers });
            this.logger.log(`Successfully updated Clover item group ID: ${itemGroupId}`);
            return response.data;
        } catch (error) {
            const errorMsg = `Failed to update Clover item group ID ${itemGroupId}: ${error.response?.data?.message || error.message}`;
            this.logger.error(errorMsg, error.stack);
            throw new InternalServerErrorException(errorMsg);
        }
    }

    // --- Item (Variant) Update ---
    async updateCloverItem(connection: PlatformConnection, merchantId: string, itemId: string, payload: Partial<CloverItemInput>): Promise<CloverCreatedItem> {
        const headers = await this.getHeaders(connection);
        const endpoint = `/v3/merchants/${merchantId}/items/${itemId}`;
        this.logger.log(`Attempting to update Clover item ID: ${itemId} for merchant: ${merchantId} with payload: ${JSON.stringify(payload)}`);
        try {
            // Clover uses POST for updates on items, not PUT/PATCH typically
            const response = await this.axiosInstance.post<CloverCreatedItem>(endpoint, payload, { headers });
            this.logger.log(`Successfully updated Clover item ID: ${itemId}`);
            return response.data;
        } catch (error) {
            const errorMsg = `Failed to update Clover item ID ${itemId}: ${error.response?.data?.message || error.message}`;
            this.logger.error(errorMsg, error.stack);
            throw new InternalServerErrorException(errorMsg);
        }
    }

    // --- Inventory Update ---
    async updateCloverItemStock(connection: PlatformConnection, merchantId: string, itemId: string, quantity: number): Promise<CloverItemStock> {
        const headers = await this.getHeaders(connection);
        // Note: Clover's API for stock update might vary slightly. Some versions use `stockCount`, others `quantity`.
        // The `POST /v3/merchants/{mId}/item_stocks/{itemId}` endpoint is typical.
        // It effectively SETS the stock, not adjusts it.
        const endpoint = `/v3/merchants/${merchantId}/item_stocks/${itemId}`;
        // The payload structure might be as simple as { quantity: X } or { stockCount: X }
        // Based on general Clover docs, { quantity: X } seems more aligned with v3 items/inventory system.
        const payload = { quantity: Math.round(quantity) }; // Ensure integer quantity

        this.logger.log(`Attempting to update stock for Clover item ID: ${itemId} to quantity: ${payload.quantity} for merchant: ${merchantId}`);
        try {
            const response = await this.axiosInstance.post<CloverItemStock>(endpoint, payload, { headers });
            this.logger.log(`Successfully updated stock for Clover item ID: ${itemId}. New quantity from response (if available): ${response.data?.quantity ?? response.data?.stockCount}`);
            return response.data;
        } catch (error) {
            const errorMsg = `Failed to update stock for Clover item ID ${itemId}: ${error.response?.data?.message || error.message}`;
            this.logger.error(errorMsg, error.stack);
            throw new InternalServerErrorException(errorMsg);
        }
    }

    // Example (updateItemStock - to be implemented later or if needed during creation)
    // async updateItemStock(connection: PlatformConnection, merchantId: string, itemId: string, newQuantity: number): Promise<CloverItemStock> {
} 