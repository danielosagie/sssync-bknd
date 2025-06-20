import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ShopifyApiClient } from './shopify-api-client.service';
import { PlatformConnection } from '../../platform-connections/platform-connections.service';
import { ActivityLogService } from '../../common/activity-log.service';

export interface ProductFilters {
  status?: 'active' | 'archived' | 'draft' | 'all';
  vendor?: string;
  productType?: string;
  title?: string;
  sku?: string;
  tag?: string;
  createdAtMin?: string;
  createdAtMax?: string;
  updatedAtMin?: string;
  updatedAtMax?: string;
}

export interface ProductUpdateData {
  title?: string;
  handle?: string;
  descriptionHtml?: string;
  vendor?: string;
  productType?: string;
  tags?: string[];
  status?: 'ACTIVE' | 'ARCHIVED' | 'DRAFT';
}

export interface InventoryUpdate {
  variantId: string;
  inventoryItemId: string;
  locationId: string;
  quantity: number;
}

export interface LocationInventory {
  locationId: string;
  locationName: string;
  available: number;
  isActive: boolean;
}

export interface ProductWithInventory {
  id: string;
  title: string;
  handle: string;
  status: string;
  vendor: string;
  productType: string;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  descriptionHtml: string;
  tags: string[];
  variants: Array<{
    id: string;
    title: string;
    price: string;
    compareAtPrice?: string;
    sku?: string;
    barcode?: string;
    inventoryQuantity: number;
    inventoryItem: {
      id: string;
      tracked: boolean;
    };
    position: number;
    availableForSale: boolean;
    inventory: LocationInventory[];
  }>;
  media: Array<{
    id: string;
    mediaContentType: string;
    image?: {
      url: string;
      altText?: string;
    };
  }>;
  totalInventoryValue: number;
  locations: LocationInventory[];
}

@Injectable()
export class ShopifyProductManagerService {
  private readonly logger = new Logger(ShopifyProductManagerService.name);

  constructor(
    private readonly shopifyApiClient: ShopifyApiClient,
    private readonly activityLogService: ActivityLogService,
  ) {}

  /**
   * Get products with comprehensive filtering and inventory data
   */
  async getProducts(
    connection: PlatformConnection,
    filters: ProductFilters = {},
    pagination: { first?: number; after?: string } = {}
  ): Promise<{
    products: ProductWithInventory[];
    pageInfo: any;
    totalCount: number;
  }> {
    const logPrefix = `[ShopifyProductManager:getProducts:${connection.Id}]`;
    this.logger.log(`${logPrefix} Fetching products with filters: ${JSON.stringify(filters)}`);

    try {
      // Build query string for Shopify
      const queryConditions: string[] = [];
      
      if (filters.status && filters.status !== 'all') {
        queryConditions.push(`status:${filters.status}`);
      }
      if (filters.vendor) {
        queryConditions.push(`vendor:'${filters.vendor}'`);
      }
      if (filters.productType) {
        queryConditions.push(`product_type:'${filters.productType}'`);
      }
      if (filters.title) {
        queryConditions.push(`title:*${filters.title}*`);
      }
      if (filters.sku) {
        queryConditions.push(`sku:${filters.sku}`);
      }
      if (filters.tag) {
        queryConditions.push(`tag:'${filters.tag}'`);
      }
      if (filters.createdAtMin) {
        queryConditions.push(`created_at:>=${filters.createdAtMin}`);
      }
      if (filters.createdAtMax) {
        queryConditions.push(`created_at:<=${filters.createdAtMax}`);
      }
      if (filters.updatedAtMin) {
        queryConditions.push(`updated_at:>=${filters.updatedAtMin}`);
      }
      if (filters.updatedAtMax) {
        queryConditions.push(`updated_at:<=${filters.updatedAtMax}`);
      }

      const query = queryConditions.length > 0 ? queryConditions.join(' AND ') : undefined;

      // Get products
      const { products, pageInfo } = await this.shopifyApiClient.getProductsWithFilters(connection, {
        first: pagination.first || 50,
        after: pagination.after,
        query,
      });

      // Get total count for reporting
      const totalCount = await this.shopifyApiClient.getProductCount(connection, query);

      // Enhance products with inventory data
      const enhancedProducts = await Promise.all(
        products.map(async (product) => this.enhanceProductWithInventory(connection, product))
      );

      await this.activityLogService.logActivity({
        UserId: connection.UserId,
        EntityType: 'Product',
        EntityId: null,
        EventType: 'PRODUCT_LIST_FETCHED',
        Status: 'Success',
        Message: `Fetched products from Shopify`,
        Details: {
          platform: 'shopify',
          count: enhancedProducts.length,
          cursor: enhancedProducts.length > 0 ? enhancedProducts[enhancedProducts.length - 1].id : null,
          filters,
        }
      });

      return {
        products: enhancedProducts,
        pageInfo,
        totalCount,
      };
    } catch (error) {
      this.logger.error(`${logPrefix} Error fetching products: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Get a single product by ID with complete inventory data
   */
  async getProductById(connection: PlatformConnection, productId: string): Promise<ProductWithInventory> {
    const logPrefix = `[ShopifyProductManager:getProductById:${connection.Id}:${productId}]`;
    this.logger.log(`${logPrefix} Fetching product details`);

    try {
      const product = await this.shopifyApiClient.getProductById(connection, productId);
      
      if (!product) {
        throw new NotFoundException(`Product ${productId} not found`);
      }

      const enhancedProduct = await this.enhanceProductWithInventory(connection, product);

      await this.activityLogService.logActivity({
        UserId: connection.UserId,
        EntityType: 'Product',
        EntityId: product.id,
        EventType: 'PRODUCT_VIEWED',
        Status: 'Success',
        Message: `Retrieved product from Shopify`,
        Details: {
          platform: 'shopify',
          productId: product.id,
          productTitle: product.title,
        }
      });

      return enhancedProduct;
    } catch (error) {
      this.logger.error(`${logPrefix} Error fetching product: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Update product details
   */
  async updateProduct(
    connection: PlatformConnection,
    productId: string,
    updates: ProductUpdateData
  ): Promise<ProductWithInventory> {
    const logPrefix = `[ShopifyProductManager:updateProduct:${connection.Id}:${productId}]`;
    this.logger.log(`${logPrefix} Updating product with: ${JSON.stringify(updates)}`);

    try {
      // Validate handle availability if updating handle
      if (updates.handle) {
        const isAvailable = await this.shopifyApiClient.isHandleAvailable(connection, updates.handle);
        if (!isAvailable) {
          throw new BadRequestException(`Handle "${updates.handle}" is already in use`);
        }
      }

      const result = await this.shopifyApiClient.updateProductDetails(connection, productId, updates);

      if (result.userErrors && result.userErrors.length > 0) {
        throw new BadRequestException(`Shopify API errors: ${result.userErrors.map(e => e.message).join(', ')}`);
      }

      // Get updated product with inventory data
      const updatedProduct = await this.getProductById(connection, productId);

      await this.activityLogService.logActivity({
        UserId: connection.UserId,
        EntityType: 'Product',
        EntityId: updatedProduct.id,
        EventType: 'PRODUCT_UPDATED',
        Status: 'Success',
        Message: `Updated product in Shopify`,
        Details: {
          platform: 'shopify',
          productId: updatedProduct.id,
          productTitle: updatedProduct.title,
          updates,
        }
      });

      return updatedProduct;
    } catch (error) {
      this.logger.error(`${logPrefix} Error updating product: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Archive a product (soft delete)
   */
  async archiveProduct(connection: PlatformConnection, productId: string): Promise<ProductWithInventory> {
    const logPrefix = `[ShopifyProductManager:archiveProduct:${connection.Id}:${productId}]`;
    this.logger.log(`${logPrefix} Archiving product`);

    try {
      const result = await this.shopifyApiClient.archiveProduct(connection, productId);

      if (result.userErrors && result.userErrors.length > 0) {
        throw new BadRequestException(`Shopify API errors: ${result.userErrors.map(e => e.message).join(', ')}`);
      }

      const archivedProduct = await this.getProductById(connection, productId);

      await this.activityLogService.logActivity({
        UserId: connection.UserId,
        EntityType: 'Product',
        EntityId: archivedProduct.id,
        EventType: 'PRODUCT_ARCHIVED',
        Status: 'Success',
        Message: `Archived product in Shopify`,
        Details: {
          platform: 'shopify',
          productId: archivedProduct.id,
          productTitle: archivedProduct.title,
        }
      });

      return archivedProduct;
    } catch (error) {
      this.logger.error(`${logPrefix} Error archiving product: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Unarchive a product (restore)
   */
  async unarchiveProduct(connection: PlatformConnection, productId: string): Promise<ProductWithInventory> {
    const logPrefix = `[ShopifyProductManager:unarchiveProduct:${connection.Id}:${productId}]`;
    this.logger.log(`${logPrefix} Unarchiving product`);

    try {
      const result = await this.shopifyApiClient.unarchiveProduct(connection, productId);

      if (result.userErrors && result.userErrors.length > 0) {
        throw new BadRequestException(`Shopify API errors: ${result.userErrors.map(e => e.message).join(', ')}`);
      }

      const unarchivedProduct = await this.getProductById(connection, productId);

      await this.activityLogService.logActivity({
        UserId: connection.UserId,
        EntityType: 'Product',
        EntityId: unarchivedProduct.id,
        EventType: 'PRODUCT_UNARCHIVED',
        Status: 'Success',
        Message: `Unarchived product in Shopify`,
        Details: {
          platform: 'shopify',
          productId: unarchivedProduct.id,
          productTitle: unarchivedProduct.title,
        }
      });

      return unarchivedProduct;
    } catch (error) {
      this.logger.error(`${logPrefix} Error unarchiving product: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Permanently delete a product
   */
  async deleteProduct(connection: PlatformConnection, productId: string): Promise<{ success: boolean; deletedProductId: string }> {
    const logPrefix = `[ShopifyProductManager:deleteProduct:${connection.Id}:${productId}]`;
    this.logger.log(`${logPrefix} Permanently deleting product`);

    try {
      // Get product info before deletion for logging
      const productInfo = await this.shopifyApiClient.getProductById(connection, productId);
      
      const result = await this.shopifyApiClient.deleteProductPermanently(connection, productId);

      if (result.userErrors && result.userErrors.length > 0) {
        throw new BadRequestException(`Shopify API errors: ${result.userErrors.map(e => e.message).join(', ')}`);
      }

      if (!result.deletedProductId) {
        throw new BadRequestException('Product deletion failed - no confirmation received');
      }

      await this.activityLogService.logActivity({
        UserId: connection.UserId,
        EntityType: 'Product',
        EntityId: result.deletedProductId,
        EventType: 'PRODUCT_DELETED',
        Status: 'Success',
        Message: `Deleted product from Shopify`,
        Details: {
          platform: 'shopify',
          productId: result.deletedProductId,
          deletedProductId: result.deletedProductId,
        }
      });

      return {
        success: true,
        deletedProductId: result.deletedProductId,
      };
    } catch (error) {
      this.logger.error(`${logPrefix} Error deleting product: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Update inventory quantities for specific variants and locations
   */
  async updateInventory(
    connection: PlatformConnection,
    updates: InventoryUpdate[],
    reason = 'Manual adjustment from sssync'
  ): Promise<{ success: boolean; adjustmentGroupId: string }> {
    const logPrefix = `[ShopifyProductManager:updateInventory:${connection.Id}]`;
    this.logger.log(`${logPrefix} Updating inventory for ${updates.length} items`);

    try {
      const inventoryUpdates = updates.map(update => ({
        inventoryItemId: update.inventoryItemId,
        locationId: update.locationId,
        quantity: update.quantity,
      }));

      const result = await this.shopifyApiClient.setInventoryQuantities(
        connection,
        inventoryUpdates,
        reason,
        `sssync://inventory-update/${Date.now()}`
      );

      if (result.userErrors && result.userErrors.length > 0) {
        throw new BadRequestException(`Shopify API errors: ${result.userErrors.map(e => e.message).join(', ')}`);
      }

      await this.activityLogService.logActivity({
        UserId: connection.UserId,
        EntityType: 'Inventory',
        EntityId: null,
        EventType: 'INVENTORY_UPDATED',
        Status: 'Success',
        Message: `Updated inventory levels in Shopify`,
        Details: {
          platform: 'shopify',
          updates: inventoryUpdates.map(update => ({
            variantId: update.inventoryItemId,
            locationId: update.locationId,
            quantity: update.quantity,
            reason: reason
          })),
        }
      });

      return {
        success: true,
        adjustmentGroupId: result.inventoryAdjustmentGroup?.id || '',
      };
    } catch (error) {
      this.logger.error(`${logPrefix} Error updating inventory: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Get all locations for inventory management
   */
  async getLocations(connection: PlatformConnection, includeInactive = false): Promise<any[]> {
    const logPrefix = `[ShopifyProductManager:getLocations:${connection.Id}]`;
    this.logger.log(`${logPrefix} Fetching locations (includeInactive: ${includeInactive})`);

    try {
      const locations = await this.shopifyApiClient.getLocationsDetailed(connection, includeInactive);

      await this.activityLogService.logActivity({
        UserId: connection.UserId,
        EntityType: 'Location',
        EntityId: null,
        EventType: 'LOCATIONS_FETCHED',
        Status: 'Success',
        Message: `Fetched locations from Shopify`,
        Details: {
          platform: 'shopify',
          count: locations.length,
          includeInactive,
        }
      });

      return locations;
    } catch (error) {
      this.logger.error(`${logPrefix} Error fetching locations: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Private helper to enhance product with inventory data
   */
  private async enhanceProductWithInventory(connection: PlatformConnection, product: any): Promise<ProductWithInventory> {
    // Get inventory data for all variants
    const inventoryItemIds = product.variants.edges
      .map((edge: any) => edge.node.inventoryItem.id)
      .filter((id: string) => id);

    let inventoryData: any[] = [];
    if (inventoryItemIds.length > 0) {
      inventoryData = await this.shopifyApiClient.getInventoryLevelsForItems(connection, inventoryItemIds);
    }

    // Create inventory map for quick lookup
    const inventoryMap = new Map();
    inventoryData.forEach((item: any) => {
      if (item.inventoryLevels) {
        item.inventoryLevels.edges.forEach((edge: any) => {
          const level = edge.node;
          const key = `${item.id}:${level.location.id}`;
          inventoryMap.set(key, {
            locationId: level.location.id,
            locationName: level.location.name,
            available: level.available,
            isActive: level.location.isActive,
          });
        });
      }
    });

    // Enhance variants with location-specific inventory
    const enhancedVariants = product.variants.edges.map((edge: any) => {
      const variant = edge.node;
      const inventory: LocationInventory[] = [];
      
      // Get inventory for this variant at all locations
      for (const [key, locationInventory] of inventoryMap) {
        if (key.startsWith(variant.inventoryItem.id + ':')) {
          inventory.push(locationInventory);
        }
      }

      return {
        ...variant,
        inventory,
      };
    });

    // Calculate total inventory value
    const totalInventoryValue = enhancedVariants.reduce((total, variant) => {
      const price = parseFloat(variant.price) || 0;
      const quantity = variant.inventory.reduce((sum, inv) => sum + inv.available, 0);
      return total + (price * quantity);
    }, 0);

    // Get unique locations across all variants
    const allLocations = new Map();
    enhancedVariants.forEach(variant => {
      variant.inventory.forEach((inv: LocationInventory) => {
        allLocations.set(inv.locationId, inv);
      });
    });

    return {
      id: product.id,
      title: product.title,
      handle: product.handle,
      status: product.status,
      vendor: product.vendor,
      productType: product.productType,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
      publishedAt: product.publishedAt,
      descriptionHtml: product.descriptionHtml,
      tags: product.tags,
      variants: enhancedVariants,
      media: product.media?.edges?.map((edge: any) => edge.node) || [],
      totalInventoryValue,
      locations: Array.from(allLocations.values()),
    };
  }
} 