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
}
