import { Injectable } from '@nestjs/common';
import { ProductVariant } from '../../common/types/supabase.types';

export interface SquareExportRow {
  Token: string;
  'Item Name': string;
  Description: string;
  Category: string;
  SKU: string;
  'Variation Name': string;
  Price: string;
  'Current Quantity Main': string;
  'Stock Alert Enabled Main': string;
  'Stock Alert Count Main': string;
  SEO: string;
  'Square Online Item Visibility': string;
  'Square Online Category': string;
  'Shipping Enabled': string;
  'Self Serve Ordering Enabled': string;
  'Delivery Enabled': string;
  'Pick Up Enabled': string;
  'Hide Price in Square Online': string;
  'Option Name 1': string;
  'Option Value 1': string;
  'Option Name 2': string;
  'Option Value 2': string;
  'Option Name 3': string;
  'Option Value 3': string;
  'Alternate Name': string;
  'Tax 1': string;
  'Tax 2': string;
  'Tax 3': string;
  'Tax 4': string;
  'Tax 5': string;
  'Tax 6': string;
  'Tax 7': string;
  'Tax 8': string;
  'Tax 9': string;
  'Tax 10': string;
  GTIN: string;
}

@Injectable()
export class SquareExportFormatter {
  formatForSquare(variants: ProductVariant[]): SquareExportRow[] {
    // Group variants by ProductId
    const productGroups = new Map<string, ProductVariant[]>();
    
    variants.forEach(variant => {
      const productId = variant.ProductId;
      if (!productGroups.has(productId)) {
        productGroups.set(productId, []);
      }
      productGroups.get(productId)!.push(variant);
    });

    const rows: SquareExportRow[] = [];

    productGroups.forEach((productVariants, productId) => {
      productVariants.forEach((variant, index) => {
        const isFirstVariant = index === 0;
        
        // Parse options if available
        const options = variant.Options ? (typeof variant.Options === 'string' ? JSON.parse(variant.Options) : variant.Options) : {};
        const optionKeys = Object.keys(options);

        rows.push({
          Token: isFirstVariant ? this.generateToken(variant.Title) : '',
          'Item Name': isFirstVariant ? variant.Title : '',
          Description: isFirstVariant ? (variant.Description || '') : '',
          Category: '',
          SKU: variant.Sku || '',
          'Variation Name': this.generateVariationName(variant, options),
          Price: String(((parseFloat(variant.Price as any) || 0) * 100).toFixed(0)), // Square uses cents
          'Current Quantity Main': '0', // TODO: Add inventory lookup
          'Stock Alert Enabled Main': 'N',
          'Stock Alert Count Main': '',
          SEO: '',
          'Square Online Item Visibility': 'VISIBLE',
          'Square Online Category': '',
          'Shipping Enabled': variant.RequiresShipping ? 'Y' : 'N',
          'Self Serve Ordering Enabled': 'Y',
          'Delivery Enabled': 'Y',
          'Pick Up Enabled': 'Y',
          'Hide Price in Square Online': 'N',
          'Option Name 1': optionKeys[0] || '',
          'Option Value 1': optionKeys[0] ? options[optionKeys[0]] : '',
          'Option Name 2': optionKeys[1] || '',
          'Option Value 2': optionKeys[1] ? options[optionKeys[1]] : '',
          'Option Name 3': optionKeys[2] || '',
          'Option Value 3': optionKeys[2] ? options[optionKeys[2]] : '',
          'Alternate Name': '',
          'Tax 1': variant.IsTaxable ? 'Tax' : '',
          'Tax 2': '',
          'Tax 3': '',
          'Tax 4': '',
          'Tax 5': '',
          'Tax 6': '',
          'Tax 7': '',
          'Tax 8': '',
          'Tax 9': '',
          'Tax 10': '',
          GTIN: variant.Barcode || '',
        });
      });
    });

    return rows;
  }

  convertToCsvString(rows: SquareExportRow[]): string {
    if (rows.length === 0) return '';

    const headers = Object.keys(rows[0]);
    const csvRows = [
      headers.join(','),
      ...rows.map(row => 
        headers.map(header => {
          const value = (row as any)[header];
          // Escape commas and quotes in CSV
          if (typeof value === 'string' && (value.includes(',') || value.includes('"'))) {
            return `"${value.replace(/"/g, '""')}"`;
          }
          return value ?? '';
        }).join(',')
      )
    ];

    return csvRows.join('\n');
  }

  private generateToken(itemName: string): string {
    return itemName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .substring(0, 255);
  }

  private generateVariationName(variant: ProductVariant, options: Record<string, any>): string {
    const optionValues = Object.values(options).filter(v => v);
    if (optionValues.length === 0) {
      return 'Regular';
    }
    return optionValues.join(' / ');
  }
}












