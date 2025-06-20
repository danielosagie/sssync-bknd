// Defines the common interface that all platform adapters must implement

// Define base types for API clients and Mappers if desired for stronger typing
// export interface BaseApiClient { initialize(connection: PlatformConnection): void; fetchAllRelevantData(): Promise<any>; /* ... */ }
// export interface BaseMapper { mapProductToCanonical(sourceProduct: any): any; /* ... */ }
export interface BaseSyncLogic { shouldDelist(canonicalQuantity: number): boolean; /* ... */ }

export interface BaseAdapter {
    // Should return an initialized instance ready to make calls for the given connection
    getApiClient(connection: any /* PlatformConnection */): any /* BaseApiClient */;

    // Should return the specific mapper for this platform
    getMapper(): any /* BaseMapper */;

    // Should return an object containing platform-specific sync rules/logic
    getSyncLogic(): BaseSyncLogic;

    // Fetches data from the platform, maps it, and saves it to the canonical store.
    syncFromPlatform(connection: any /* PlatformConnection */, userId: string): Promise<void>;

    // --- Push to Platform Methods ---

    /**
     * Creates a new product with its variants and inventory levels on the platform.
     * @param connection The platform connection details.
     * @param canonicalProduct The canonical product data (without variants).
     * @param canonicalVariants Array of canonical variant data for this product.
     * @param canonicalInventoryLevels Array of canonical inventory levels for these variants.
     * @returns Platform-specific identifiers for the created product and variants (e.g., { platformProductId: string, platformVariantIds: Record<string, string> }) or throws an error.
     */
    createProduct(
        connection: any, // PlatformConnection
        canonicalProduct: any, // CanonicalProduct (as defined in a central place)
        canonicalVariants: any[], // CanonicalProductVariant[]
        canonicalInventoryLevels: any[], // CanonicalInventoryLevel[] (relevant to these variants)
    ): Promise<{ platformProductId: string; platformVariantIds: Record<string, string> }>;

    /**
     * Updates an existing product, its variants, and inventory levels on the platform.
     * @param connection The platform connection details.
     * @param existingMapping The existing platform product mapping.
     * @param canonicalProduct The canonical product data.
     * @param canonicalVariants Array of canonical variant data.
     * @param canonicalInventoryLevels Array of canonical inventory levels.
     * @returns Platform-specific identifiers or success status.
     */
    updateProduct(
        connection: any, // PlatformConnection
        existingMapping: any, // PlatformProductMapping (or just platformProductId/platformVariantId)
        canonicalProduct: any, // CanonicalProduct
        canonicalVariants: any[], // CanonicalProductVariant[]
        canonicalInventoryLevels: any[], // CanonicalInventoryLevel[]
    ): Promise<any>;

    /**
     * Deletes a product from the platform.
     * @param connection The platform connection details.
     * @param existingMapping The existing platform product mapping to identify the product on the platform.
     * @returns Success status or throws an error.
     */
    deleteProduct(
        connection: any, // PlatformConnection
        existingMapping: any, // PlatformProductMapping
    ): Promise<void>;

    /**
     * Updates inventory levels for specified variants on the platform.
     * Could be for a single variant or a batch.
     * @param connection The platform connection details.
     * @param inventoryUpdates Array of updates, each containing mapping info and new canonical level.
     *                       Example: { mapping: PlatformProductMapping, level: CanonicalInventoryLevel }[]
     * @returns Success status or detailed results per update.
     */
    updateInventoryLevels(
        connection: any, // PlatformConnection
        inventoryUpdates: Array<{ mapping: any /* PlatformProductMapping */; level: any /* CanonicalInventoryLevel */ }>
    ): Promise<any>;

    /**
     * Processes an incoming webhook payload for the platform.
     * This method is responsible for parsing the payload, determining the event,
     * and updating the canonical data store accordingly.
     * @param connection The platform connection associated with this webhook.
     * @param payload The parsed webhook payload.
     * @param headers The headers from the incoming webhook request (for context or further verification).
     * @param webhookId Optional webhook ID for tracking and logging.
     * @returns A promise that resolves when processing is complete.
     */
    processWebhook(
        connection: any, // PlatformConnection
        payload: any,
        headers: Record<string, string>, // Added headers
        webhookId?: string // Added optional webhookId parameter
    ): Promise<void>;

    /**
     * Fetches a single product and its variants from the platform and updates the canonical store.
     * Useful for processing webhooks that indicate a specific product has changed.
     * @param connection The platform connection details.
     * @param platformProductId The platform-specific ID of the product to sync.
     * @param userId The ID of the user who owns this connection/product.
     * @returns A promise that resolves when the single product sync is complete.
     */
    syncSingleProductFromPlatform(
        connection: any, // PlatformConnection
        platformProductId: string,
        userId: string, // Added userId for context when saving canonical data
    ): Promise<void>;

    // TODO: Consider if a separate delistProduct (archive/hide) is needed or if it's part of updateProduct.
    // For now, IsArchived in CanonicalProduct/Variant can drive status changes via updateProduct.
}
