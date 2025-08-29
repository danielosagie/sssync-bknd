import { Injectable } from '@nestjs/common';
import { ProductVariant } from '../../common/types/supabase.types';

export interface CsvExportRow {
  product_id: string;
  variant_id: string;
  sku: string;
  title: string;
  description: string;
  price: number;
  compare_at_price: number | null;
  barcode: string;
  weight: number | null;
  weight_unit: string;
  requires_shipping: boolean;
  is_taxable: boolean;
  tax_code: string;
  inventory_quantity: number;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class CsvExportFormatter {
  formatForCsv(variants: ProductVariant[], includeInventory = true): CsvExportRow[] {
    return variants.map(variant => ({
      product_id: variant.ProductId,
      variant_id: variant.Id!,
      sku: variant.Sku || '',
      title: variant.Title,
      description: variant.Description || '',
      price: parseFloat(variant.Price as any) || 0,
      compare_at_price: variant.CompareAtPrice ? parseFloat(variant.CompareAtPrice as any) : null,
      barcode: variant.Barcode || '',
      weight: variant.Weight ? parseFloat(variant.Weight as any) : null,
      weight_unit: variant.WeightUnit || 'kg',
      requires_shipping: variant.RequiresShipping || false,
      is_taxable: variant.IsTaxable || false,
      tax_code: variant.TaxCode || '',
      inventory_quantity: includeInventory ? 0 : 0, // TODO: Add inventory lookup
      is_archived: false, // TODO: Add IsArchived field to ProductVariant type
      created_at: variant.CreatedAt as string,
      updated_at: variant.UpdatedAt as string,
    }));
  }

  convertToCsvString(rows: CsvExportRow[]): string {
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
}
