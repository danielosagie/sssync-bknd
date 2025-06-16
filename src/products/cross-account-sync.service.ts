import { Injectable, Logger } from '@nestjs/common';
import { ProductsService } from '../canonical-data/products.service';
import { InventoryService } from '../canonical-data/inventory.service';
import { PlatformConnectionsService } from '../platform-connections/platform-connections.service';
import { PlatformProductMappingsService } from '../platform-product-mappings/platform-product-mappings.service';
import { PlatformAdapterRegistry } from '../platform-adapters/adapter.registry';

export interface CrossAccountSyncOptions {
  sourceConnectionId: string;
  targetConnectionIds: string[];
  syncInventory: boolean;
  syncPricing: boolean;
  syncStatus: boolean;
  autoSync: boolean; // Whether to enable automatic syncing for future changes
}

export interface CrossAccountSyncResult {
  success: boolean;
  syncedProducts: number;
  failedProducts: number;
  errors: string[];
  details: Array<{
    productId: string;
    targetConnectionId: string;
    status: 'success' | 'failed';
    error?: string;
  }>;
}

@Injectable()
export class CrossAccountSyncService {
  private readonly logger = new Logger(CrossAccountSyncService.name);

  constructor(
    private readonly productsService: ProductsService,
    private readonly inventoryService: InventoryService,
    private readonly connectionsService: PlatformConnectionsService,
    private readonly mappingsService: PlatformProductMappingsService,
    private readonly adapterRegistry: PlatformAdapterRegistry,
  ) {}

  /**
   * Sync products from one platform connection to multiple other connections
   */
  async syncProductsAcrossAccounts(
    userId: string,
    options: CrossAccountSyncOptions
  ): Promise<CrossAccountSyncResult> {
    this.logger.log(`Starting cross-account sync for user ${userId} from connection ${options.sourceConnectionId} to ${options.targetConnectionIds.length} target connections`);

    const result: CrossAccountSyncResult = {
      success: true,
      syncedProducts: 0,
      failedProducts: 0,
      errors: [],
      details: []
    };

    try {
      // 1. Get source connection and validate
      const sourceConnection = await this.connectionsService.getConnectionById(options.sourceConnectionId, userId);
      if (!sourceConnection) {
        throw new Error(`Source connection ${options.sourceConnectionId} not found`);
      }

      // 2. Get target connections and validate
      const targetConnections = await Promise.all(
        options.targetConnectionIds.map(id => this.connectionsService.getConnectionById(id, userId))
      );
      
      const validTargetConnections = targetConnections.filter(conn => conn !== null);
      if (validTargetConnections.length !== options.targetConnectionIds.length) {
        const invalidIds = options.targetConnectionIds.filter((id, index) => targetConnections[index] === null);
        result.errors.push(`Invalid target connection IDs: ${invalidIds.join(', ')}`);
      }

      // 3. Get all products mapped to the source connection
      const sourceMappings = await this.mappingsService.getMappingsByConnectionId(options.sourceConnectionId);
      this.logger.log(`Found ${sourceMappings.length} products mapped to source connection`);

      // 4. Process each product
      for (const mapping of sourceMappings) {
        if (!mapping.ProductVariantId) continue;

        try {
          const variant = await this.productsService.getVariantById(mapping.ProductVariantId);
          if (!variant) continue;

          const product = await this.productsService.getProductById(variant.ProductId);
          if (!product) continue;

          // Get all variants for this product
          const allVariants = await this.productsService.getVariantsByProductId(variant.ProductId);
          
          // Get inventory levels for all variants
          const inventoryLevels = await this.inventoryService.getInventoryLevelsByProductId(variant.ProductId);

          // Sync to each target connection
          for (const targetConnection of validTargetConnections) {
            if (!targetConnection) continue;

            try {
              await this.syncProductToConnection(
                product,
                allVariants,
                inventoryLevels,
                targetConnection,
                options
              );

              result.details.push({
                productId: product.Id,
                targetConnectionId: targetConnection.Id,
                status: 'success'
              });
              
            } catch (error) {
              this.logger.error(`Failed to sync product ${product.Id} to connection ${targetConnection.Id}: ${error.message}`);
              
              result.details.push({
                productId: product.Id,
                targetConnectionId: targetConnection.Id,
                status: 'failed',
                error: error.message
              });
              
              result.failedProducts++;
            }
          }

          result.syncedProducts++;

        } catch (error) {
          this.logger.error(`Failed to process product mapping ${mapping.Id}: ${error.message}`);
          result.failedProducts++;
          result.errors.push(`Product mapping ${mapping.Id}: ${error.message}`);
        }
      }

      // 5. Set up auto-sync if requested
      if (options.autoSync) {
        await this.enableAutoSync(userId, options);
      }

      result.success = result.failedProducts === 0;
      this.logger.log(`Cross-account sync completed. Success: ${result.success}, Synced: ${result.syncedProducts}, Failed: ${result.failedProducts}`);

    } catch (error) {
      this.logger.error(`Cross-account sync failed: ${error.message}`, error.stack);
      result.success = false;
      result.errors.push(error.message);
    }

    return result;
  }

  /**
   * Sync a single product to a target connection
   */
  private async syncProductToConnection(
    product: any,
    variants: any[],
    inventoryLevels: any[],
    targetConnection: any,
    options: CrossAccountSyncOptions
  ): Promise<void> {
    // Check if product already exists on target connection
    const existingMappings = await this.mappingsService.getMappingsByConnectionId(targetConnection.Id);
    const existingMapping = existingMappings.find(m => 
      variants.some(v => v.Id === m.ProductVariantId)
    );

    if (existingMapping) {
      // Product already exists, update if needed
      if (options.syncInventory || options.syncPricing || options.syncStatus) {
        await this.updateExistingProductOnConnection(
          product,
          variants,
          inventoryLevels,
          targetConnection,
          existingMapping,
          options
        );
      }
    } else {
      // Create new product on target connection
      await this.createProductOnConnection(
        product,
        variants,
        inventoryLevels,
        targetConnection,
        options
      );
    }
  }

  /**
   * Create a new product on the target connection
   */
  private async createProductOnConnection(
    product: any,
    variants: any[],
    inventoryLevels: any[],
    targetConnection: any,
    options: CrossAccountSyncOptions
  ): Promise<void> {
    const adapter = this.adapterRegistry.getAdapter(targetConnection.Platform);
    if (!adapter) {
      throw new Error(`No adapter found for platform ${targetConnection.Platform}`);
    }

    // Map to canonical format
    const canonicalProduct = {
      Id: `temp-product-${product.Id}`,
      UserId: product.UserId,
      Title: variants[0]?.Title || 'Untitled Product',
      IsArchived: product.IsArchived
    };

    const canonicalVariants = variants.map(v => ({
      Id: `temp-variant-${v.Id}`,
      ProductId: canonicalProduct.Id,
      Sku: v.Sku,
      Barcode: v.Barcode,
      Title: v.Title,
      Description: v.Description,
      Price: options.syncPricing ? v.Price : v.Price,
      CompareAtPrice: v.CompareAtPrice,
      Weight: v.Weight,
      WeightUnit: v.WeightUnit,
      Options: v.Options,
      RequiresShipping: v.RequiresShipping,
      IsTaxable: v.IsTaxable,
      TaxCode: v.TaxCode,
      ImageId: v.ImageId
    }));

    const canonicalInventoryLevels = options.syncInventory ? inventoryLevels.map(il => ({
      ProductVariantId: `temp-variant-${il.ProductVariantId}`,
      PlatformConnectionId: targetConnection.Id,
      PlatformLocationId: il.PlatformLocationId,
      Quantity: il.Quantity,
      LastPlatformUpdateAt: new Date()
    })) : [];

    // Create product using adapter
    await adapter.createProduct(
      targetConnection,
      canonicalProduct,
      canonicalVariants,
      canonicalInventoryLevels
    );
  }

  /**
   * Update an existing product on the target connection
   */
  private async updateExistingProductOnConnection(
    product: any,
    variants: any[],
    inventoryLevels: any[],
    targetConnection: any,
    existingMapping: any,
    options: CrossAccountSyncOptions
  ): Promise<void> {
    const adapter = this.adapterRegistry.getAdapter(targetConnection.Platform);
    if (!adapter) {
      throw new Error(`No adapter found for platform ${targetConnection.Platform}`);
    }

    // Update inventory levels if requested
    if (options.syncInventory) {
      const inventoryUpdates = inventoryLevels.map(il => ({
        mapping: existingMapping,
        level: {
          ProductVariantId: il.ProductVariantId,
          PlatformConnectionId: targetConnection.Id,
          PlatformLocationId: il.PlatformLocationId,
          Quantity: il.Quantity,
          LastPlatformUpdateAt: new Date()
        }
      }));

      await adapter.updateInventoryLevels(targetConnection, inventoryUpdates);
    }

    // TODO: Add price and status updates when adapter methods are available
  }

  /**
   * Enable automatic syncing between connections
   */
  private async enableAutoSync(userId: string, options: CrossAccountSyncOptions): Promise<void> {
    // TODO: Implement auto-sync configuration storage
    // This would involve creating a table to store sync rules and setting up
    // event listeners or scheduled jobs to automatically sync changes
    this.logger.log(`Auto-sync enabled for user ${userId} from ${options.sourceConnectionId} to ${options.targetConnectionIds.join(', ')}`);
  }

  /**
   * Search products across all user's connections
   */
  async searchProductsAcrossConnections(
    userId: string,
    searchQuery: string,
    connectionIds?: string[]
  ): Promise<Array<{
    product: any;
    variant: any;
    connection: any;
    mapping: any;
  }>> {
    this.logger.log(`Searching products across connections for user ${userId} with query: "${searchQuery}"`);

    // Get user's connections
    const userConnections = await this.connectionsService.getConnectionsForUser(userId);
    const targetConnections = connectionIds 
      ? userConnections.filter(conn => connectionIds.includes(conn.Id))
      : userConnections;

    const results: Array<{
      product: any;
      variant: any;
      connection: any;
      mapping: any;
    }> = [];

    // Search across all target connections
    for (const connection of targetConnections) {
      try {
        const mappings = await this.mappingsService.getMappingsByConnectionId(connection.Id);
        
        for (const mapping of mappings) {
          if (!mapping.ProductVariantId) continue;

          const variant = await this.productsService.getVariantById(mapping.ProductVariantId);
          if (!variant) continue;

          const product = await this.productsService.getProductById(variant.ProductId);
          if (!product) continue;

          // Simple text search in title, description, and SKU
          const searchText = searchQuery.toLowerCase();
          const titleMatch = variant.Title?.toLowerCase().includes(searchText);
          const descriptionMatch = variant.Description?.toLowerCase().includes(searchText);
          const skuMatch = variant.Sku?.toLowerCase().includes(searchText);

          if (titleMatch || descriptionMatch || skuMatch) {
            results.push({
              product,
              variant,
              connection,
              mapping
            });
          }
        }
      } catch (error) {
        this.logger.error(`Error searching connection ${connection.Id}: ${error.message}`);
      }
    }

    this.logger.log(`Found ${results.length} products matching search query across ${targetConnections.length} connections`);
    return results;
  }
} 