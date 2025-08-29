import { Injectable } from '@nestjs/common';
import { ProductVariant } from '../../common/types/supabase.types';

export interface ShopifyExportRow {
  Handle: string;
  Title: string;
  'Body (HTML)': string;
  Vendor: string;
  'Product Category': string;
  Type: string;
  Tags: string;
  Published: string;
  'Option1 Name': string;
  'Option1 Value': string;
  'Option2 Name': string;
  'Option2 Value': string;
  'Option3 Name': string;
  'Option3 Value': string;
  'Variant SKU': string;
  'Variant Grams': string;
  'Variant Inventory Tracker': string;
  'Variant Inventory Qty': string;
  'Variant Inventory Policy': string;
  'Variant Fulfillment Service': string;
  'Variant Price': string;
  'Variant Compare At Price': string;
  'Variant Requires Shipping': string;
  'Variant Taxable': string;
  'Variant Barcode': string;
  'Image Src': string;
  'Image Position': string;
  'Image Alt Text': string;
  'Gift Card': string;
  'SEO Title': string;
  'SEO Description': string;
  'Google Shopping / Google Product Category': string;
  'Google Shopping / Gender': string;
  'Google Shopping / Age Group': string;
  'Google Shopping / MPN': string;
  'Google Shopping / AdWords Grouping': string;
  'Google Shopping / AdWords Labels': string;
  'Google Shopping / Condition': string;
  'Google Shopping / Custom Product': string;
  'Google Shopping / Custom Label 0': string;
  'Google Shopping / Custom Label 1': string;
  'Google Shopping / Custom Label 2': string;
  'Google Shopping / Custom Label 3': string;
  'Google Shopping / Custom Label 4': string;
  'Variant Image': string;
  'Variant Weight Unit': string;
  'Variant Tax Code': string;
  'Cost per item': string;
  'Price / International': string;
  'Compare At Price / International': string;
  Status: string;
}

@Injectable()
export class ShopifyExportFormatter {
  formatForShopify(variants: ProductVariant[]): ShopifyExportRow[] {
    // Group variants by ProductId to create proper Shopify CSV structure
    const productGroups = new Map<string, ProductVariant[]>();
    
    variants.forEach(variant => {
      const productId = variant.ProductId;
      if (!productGroups.has(productId)) {
        productGroups.set(productId, []);
      }
      productGroups.get(productId)!.push(variant);
    });

    const rows: ShopifyExportRow[] = [];

    productGroups.forEach((productVariants, productId) => {
      productVariants.forEach((variant, index) => {
        const isFirstVariant = index === 0;
        const handle = this.generateHandle(variant.Title);
        
        // Parse options if available
        const options = variant.Options ? (typeof variant.Options === 'string' ? JSON.parse(variant.Options) : variant.Options) : {};
        const optionKeys = Object.keys(options);

        rows.push({
          Handle: isFirstVariant ? handle : '',
          Title: isFirstVariant ? variant.Title : '',
          'Body (HTML)': isFirstVariant ? (variant.Description || '') : '',
          Vendor: '',
          'Product Category': '',
          Type: '',
          Tags: '',
          Published: 'TRUE',
          'Option1 Name': optionKeys[0] || '',
          'Option1 Value': optionKeys[0] ? options[optionKeys[0]] : '',
          'Option2 Name': optionKeys[1] || '',
          'Option2 Value': optionKeys[1] ? options[optionKeys[1]] : '',
          'Option3 Name': optionKeys[2] || '',
          'Option3 Value': optionKeys[2] ? options[optionKeys[2]] : '',
          'Variant SKU': variant.Sku || '',
          'Variant Grams': variant.Weight ? String(Math.round(parseFloat(variant.Weight as any) * 1000)) : '', // Convert to grams
          'Variant Inventory Tracker': 'shopify',
          'Variant Inventory Qty': '0', // TODO: Add inventory lookup
          'Variant Inventory Policy': 'deny',
          'Variant Fulfillment Service': 'manual',
          'Variant Price': String(variant.Price || 0),
          'Variant Compare At Price': variant.CompareAtPrice ? String(variant.CompareAtPrice) : '',
          'Variant Requires Shipping': variant.RequiresShipping ? 'TRUE' : 'FALSE',
          'Variant Taxable': variant.IsTaxable ? 'TRUE' : 'FALSE',
          'Variant Barcode': variant.Barcode || '',
          'Image Src': '',
          'Image Position': '',
          'Image Alt Text': '',
          'Gift Card': 'FALSE',
          'SEO Title': '',
          'SEO Description': '',
          'Google Shopping / Google Product Category': '',
          'Google Shopping / Gender': '',
          'Google Shopping / Age Group': '',
          'Google Shopping / MPN': '',
          'Google Shopping / AdWords Grouping': '',
          'Google Shopping / AdWords Labels': '',
          'Google Shopping / Condition': 'new',
          'Google Shopping / Custom Product': 'FALSE',
          'Google Shopping / Custom Label 0': '',
          'Google Shopping / Custom Label 1': '',
          'Google Shopping / Custom Label 2': '',
          'Google Shopping / Custom Label 3': '',
          'Google Shopping / Custom Label 4': '',
          'Variant Image': '',
          'Variant Weight Unit': variant.WeightUnit || 'kg',
          'Variant Tax Code': variant.TaxCode || '',
          'Cost per item': '', // TODO: Add Cost field to ProductVariant type
          'Price / International': '',
          'Compare At Price / International': '',
          Status: 'active', // TODO: Add IsArchived field to ProductVariant type
        });
      });
    });

    return rows;
  }

  convertToCsvString(rows: ShopifyExportRow[]): string {
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

  private generateHandle(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 255);
  }
}
