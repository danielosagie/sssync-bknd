import { Injectable, Logger } from '@nestjs/common';
import { CanonicalProduct, CanonicalProductVariant } from '../shopify/shopify.mapper';
import { CanonicalInventoryLevel } from '../../canonical-data/inventory.service';

@Injectable()
export class EbayMapper {
  private readonly logger = new Logger(EbayMapper.name);

  mapEbayDataToCanonical(
    ebayData: { items: any[]; locations: any[] },
    userId: string,
    platformConnectionId: string
  ): { canonicalProducts: CanonicalProduct[]; canonicalVariants: CanonicalProductVariant[]; canonicalInventoryLevels: CanonicalInventoryLevel[] } {
    const products: CanonicalProduct[] = [];
    const variants: CanonicalProductVariant[] = [];
    const inv: CanonicalInventoryLevel[] = [];

    const items = ebayData.items || [];
    for (const it of items) {
      const sku = it?.sku || it?.skuValue || null;
      const title = it?.product?.title || it?.productTitle || sku || 'Untitled';
      const price = it?.offers?.[0]?.price?.value ? parseFloat(it.offers[0].price.value) : 0;
      const canonicalProductId = `ebay-prod-${sku || it?.product?.epid || it?.product?.brand || Math.random().toString(36).slice(2)}`;
      products.push({ Id: canonicalProductId, UserId: userId, IsArchived: false, Title: title });
      variants.push({
        Id: `ebay-var-${sku || Math.random().toString(36).slice(2)}`,
        ProductId: canonicalProductId,
        UserId: userId,
        Sku: sku,
        Title: title,
        Price: price,
        Barcode: null,
      });
      // Inventory is exposed via separate endpoints; skip for now
    }

    this.logger.log(`Mapped ${products.length} eBay items to canonical`);
    return { canonicalProducts: products, canonicalVariants: variants, canonicalInventoryLevels: inv };
  }
}












