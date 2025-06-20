import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  Logger,
  UseGuards,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ShopifyProductManagerService, ProductFilters, ProductUpdateData, InventoryUpdate } from './shopify-product-manager.service';
import { PlatformConnectionsService } from '../../platform-connections/platform-connections.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthGuard } from '../../common/guards/auth.guard';

interface ProductListQuery {
  // Pagination
  first?: number;
  after?: string;

  // Filters
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

interface UpdateInventoryRequest {
  updates: InventoryUpdate[];
  reason?: string;
}

@Controller('shopify/:connectionId/products')
@UseGuards(AuthGuard)
export class ShopifyProductsController {
  private readonly logger = new Logger(ShopifyProductsController.name);

  constructor(
    private readonly shopifyProductManager: ShopifyProductManagerService,
    private readonly connectionsService: PlatformConnectionsService,
  ) {}

  /**
   * List products with filtering and pagination
   */
  @Get()
  async getProducts(
    @Param('connectionId') connectionId: string,
    @CurrentUser() user: any,
    @Query() query: ProductListQuery,
  ) {
    const connection = await this.getValidatedConnection(connectionId, user.userId);

    const filters: ProductFilters = {
      status: query.status,
      vendor: query.vendor,
      productType: query.productType,
      title: query.title,
      sku: query.sku,
      tag: query.tag,
      createdAtMin: query.createdAtMin,
      createdAtMax: query.createdAtMax,
      updatedAtMin: query.updatedAtMin,
      updatedAtMax: query.updatedAtMax,
    };

    const pagination = {
      first: query.first ? Math.min(query.first, 250) : 50, // Limit to reasonable size
      after: query.after,
    };

    return this.shopifyProductManager.getProducts(connection, filters, pagination);
  }

  /**
   * Get a single product by ID
   */
  @Get(':productId')
  async getProduct(
    @Param('connectionId') connectionId: string,
    @Param('productId') productId: string,
    @CurrentUser() user: any,
  ) {
    const connection = await this.getValidatedConnection(connectionId, user.userId);
    return this.shopifyProductManager.getProductById(connection, productId);
  }

  /**
   * Update product details
   */
  @Put(':productId')
  async updateProduct(
    @Param('connectionId') connectionId: string,
    @Param('productId') productId: string,
    @Body() updates: ProductUpdateData,
    @CurrentUser() user: any,
  ) {
    const connection = await this.getValidatedConnection(connectionId, user.userId);
    return this.shopifyProductManager.updateProduct(connection, productId, updates);
  }

  /**
   * Archive a product (soft delete)
   */
  @Post(':productId/archive')
  @HttpCode(HttpStatus.OK)
  async archiveProduct(
    @Param('connectionId') connectionId: string,
    @Param('productId') productId: string,
    @CurrentUser() user: any,
  ) {
    const connection = await this.getValidatedConnection(connectionId, user.userId);
    return this.shopifyProductManager.archiveProduct(connection, productId);
  }

  /**
   * Unarchive a product (restore)
   */
  @Post(':productId/unarchive')
  @HttpCode(HttpStatus.OK)
  async unarchiveProduct(
    @Param('connectionId') connectionId: string,
    @Param('productId') productId: string,
    @CurrentUser() user: any,
  ) {
    const connection = await this.getValidatedConnection(connectionId, user.userId);
    return this.shopifyProductManager.unarchiveProduct(connection, productId);
  }

  /**
   * Permanently delete a product
   */
  @Delete(':productId')
  @HttpCode(HttpStatus.OK)
  async deleteProduct(
    @Param('connectionId') connectionId: string,
    @Param('productId') productId: string,
    @CurrentUser() user: any,
  ) {
    const connection = await this.getValidatedConnection(connectionId, user.userId);
    return this.shopifyProductManager.deleteProduct(connection, productId);
  }

  /**
   * Update inventory quantities for a product's variants
   */
  @Put(':productId/inventory')
  async updateInventory(
    @Param('connectionId') connectionId: string,
    @Param('productId') productId: string,
    @Body() request: UpdateInventoryRequest,
    @CurrentUser() user: any,
  ) {
    const connection = await this.getValidatedConnection(connectionId, user.userId);
    
    if (!request.updates || request.updates.length === 0) {
      throw new BadRequestException('No inventory updates provided');
    }

    // Validate that all updates are for variants of the specified product
    const product = await this.shopifyProductManager.getProductById(connection, productId);
    const validVariantIds = product.variants.map(v => v.id);
    
    const invalidUpdates = request.updates.filter(update => 
      !validVariantIds.includes(update.variantId)
    );
    
    if (invalidUpdates.length > 0) {
      throw new BadRequestException(
        `Invalid variant IDs for product ${productId}: ${invalidUpdates.map(u => u.variantId).join(', ')}`
      );
    }

    return this.shopifyProductManager.updateInventory(
      connection,
      request.updates,
      request.reason || `Inventory update for product ${productId} from sssync`
    );
  }

  /**
   * Get locations for inventory management
   */
  @Get('_/locations')
  async getLocations(
    @Param('connectionId') connectionId: string,
    @CurrentUser() user: any,
    @Query('includeInactive') includeInactive?: boolean,
  ) {
    const connection = await this.getValidatedConnection(connectionId, user.userId);
    return this.shopifyProductManager.getLocations(connection, includeInactive === true);
  }

  /**
   * Batch operations
   */

  /**
   * Archive multiple products
   */
  @Post('_/archive')
  @HttpCode(HttpStatus.OK)
  async archiveProducts(
    @Param('connectionId') connectionId: string,
    @Body() request: { productIds: string[] },
    @CurrentUser() user: any,
  ) {
    const connection = await this.getValidatedConnection(connectionId, user.userId);
    
    if (!request.productIds || request.productIds.length === 0) {
      throw new BadRequestException('No product IDs provided');
    }

    const results = await Promise.allSettled(
      request.productIds.map(productId =>
        this.shopifyProductManager.archiveProduct(connection, productId)
      )
    );

    const successful = results
      .filter((result, index) => result.status === 'fulfilled')
      .map((result, index) => ({
        productId: request.productIds[index],
        product: (result as PromiseFulfilledResult<any>).value,
      }));

    const failed = results
      .filter((result, index) => result.status === 'rejected')
      .map((result, index) => ({
        productId: request.productIds[index],
        error: (result as PromiseRejectedResult).reason.message,
      }));

    return {
      successful: successful.length,
      failed: failed.length,
      results: {
        successful,
        failed,
      },
    };
  }

  /**
   * Delete multiple products
   */
  @Delete('_/batch')
  @HttpCode(HttpStatus.OK)
  async deleteProducts(
    @Param('connectionId') connectionId: string,
    @Body() request: { productIds: string[] },
    @CurrentUser() user: any,
  ) {
    const connection = await this.getValidatedConnection(connectionId, user.userId);
    
    if (!request.productIds || request.productIds.length === 0) {
      throw new BadRequestException('No product IDs provided');
    }

    const results = await Promise.allSettled(
      request.productIds.map(productId =>
        this.shopifyProductManager.deleteProduct(connection, productId)
      )
    );

    const successful = results
      .filter((result, index) => result.status === 'fulfilled')
      .map((result, index) => ({
        productId: request.productIds[index],
        result: (result as PromiseFulfilledResult<any>).value,
      }));

    const failed = results
      .filter((result, index) => result.status === 'rejected')
      .map((result, index) => ({
        productId: request.productIds[index],
        error: (result as PromiseRejectedResult).reason.message,
      }));

    return {
      successful: successful.length,
      failed: failed.length,
      results: {
        successful,
        failed,
      },
    };
  }

  /**
   * Update status for multiple products
   */
  @Put('_/status')
  async updateProductsStatus(
    @Param('connectionId') connectionId: string,
    @Body() request: { productIds: string[]; status: 'ACTIVE' | 'ARCHIVED' | 'DRAFT' },
    @CurrentUser() user: any,
  ) {
    const connection = await this.getValidatedConnection(connectionId, user.userId);
    
    if (!request.productIds || request.productIds.length === 0) {
      throw new BadRequestException('No product IDs provided');
    }

    if (!['ACTIVE', 'ARCHIVED', 'DRAFT'].includes(request.status)) {
      throw new BadRequestException('Invalid status. Must be ACTIVE, ARCHIVED, or DRAFT');
    }

    const results = await Promise.allSettled(
      request.productIds.map(productId =>
        this.shopifyProductManager.updateProduct(connection, productId, { status: request.status })
      )
    );

    const successful = results
      .filter((result, index) => result.status === 'fulfilled')
      .map((result, index) => ({
        productId: request.productIds[index],
        product: (result as PromiseFulfilledResult<any>).value,
      }));

    const failed = results
      .filter((result, index) => result.status === 'rejected')
      .map((result, index) => ({
        productId: request.productIds[index],
        error: (result as PromiseRejectedResult).reason.message,
      }));

    return {
      successful: successful.length,
      failed: failed.length,
      results: {
        successful,
        failed,
      },
    };
  }

  /**
   * Private helper to validate connection ownership
   */
  private async getValidatedConnection(connectionId: string, userId: string) {
    const connection = await this.connectionsService.getConnectionById(connectionId, userId);
    
    if (!connection) {
      throw new NotFoundException(`Connection ${connectionId} not found`);
    }

    if (connection.PlatformType !== 'shopify') {
      throw new BadRequestException(`Connection ${connectionId} is not a Shopify connection`);
    }

    if (!connection.IsEnabled) {
      throw new BadRequestException(`Connection ${connectionId} is disabled`);
    }

    return connection;
  }
} 