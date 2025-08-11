export type PlatformKey = 'shopify' | 'amazon' | 'ebay' | 'whatnot' | 'square' | 'facebook' | 'clover';

export interface PlatformSchemaSpec {
  requiredFields: string[];
  enums?: Record<string, string[]>; // field -> allowed values
}

export const PlatformSchemas: Record<PlatformKey, PlatformSchemaSpec> = {
  shopify: {
    requiredFields: ['title', 'description', 'price', 'vendor', 'productType', 'status'],
    enums: {
      status: ['active', 'draft', 'archived'],
      weightUnit: ['POUNDS', 'KILOGRAMS', 'OUNCES', 'GRAMS'],
    },
  },
  amazon: {
    requiredFields: ['title', 'description', 'price', 'amazonProductType', 'productIdType'],
    enums: {
      productIdType: ['UPC', 'EAN', 'GTIN', 'ASIN', 'ISBN'],
      condition: ['New', 'Used', 'Refurbished'],
    },
  },
  ebay: {
    requiredFields: ['title', 'description', 'price', 'listingFormat', 'duration'],
    enums: {
      listingFormat: ['FixedPrice', 'Auction'],
      duration: ['GTC'],
    },
  },
  whatnot: {
    requiredFields: ['title', 'description', 'price', 'type', 'quantity'],
    enums: {
      type: ['Buy it Now', 'Auction'],
      hazmat: ['Not Hazmat', 'Hazmat'],
    },
  },
  square: {
    requiredFields: ['categorySuggestion'],
    enums: {
      // Nested fields are not validated here; keep top-level guidance only
    },
  },
  facebook: {
    requiredFields: ['title', 'description', 'price', 'availability', 'condition', 'image_link'],
    enums: {
      availability: ['in stock', 'out of stock', 'available for order'],
      condition: ['new', 'refurbished', 'used'],
    },
  },
  clover: {
    requiredFields: ['name', 'price', 'priceType', 'sku', 'availability'],
    enums: {
      priceType: ['FIXED', 'VARIABLE'],
      availability: ['in stock', 'out of stock'],
    },
  },
};

export function buildPlatformConstraintsText(platforms: string[]): string {
  const lines: string[] = [];
  lines.push('\nSTRICT SCHEMA CONSTRAINTS FOR SELECTED PLATFORMS:');
  for (const p of platforms) {
    const key = p as PlatformKey;
    const spec = PlatformSchemas[key as PlatformKey];
    if (!spec) continue;
    lines.push(`\n${p.toUpperCase()}:`);
    if (spec.requiredFields?.length) {
      lines.push(`- REQUIRED FIELDS: ${spec.requiredFields.join(', ')}`);
    }
    if (spec.enums && Object.keys(spec.enums).length) {
      lines.push(`- ENUM CONSTRAINTS:`);
      for (const [field, allowed] of Object.entries(spec.enums)) {
        lines.push(`  • ${field}: one of [${allowed.join(', ')}]`);
      }
    }
  }
  lines.push('\nReturn ONLY keys for these platforms in the top-level JSON.');
  return lines.join('\n');
}

export function validateAgainstPlatformSchemas(
  output: any,
  platforms: string[],
  requestedByPlatform: Record<string, string[] | undefined>
) {
  for (const p of platforms) {
    const spec = PlatformSchemas[p as PlatformKey];
    if (!spec) continue;
    const obj = output?.[p] || {};

    // Determine required set: requestedFields (additive) or registry requiredFields
    const requested = requestedByPlatform[p];
    const requiredSet = (requested && requested.length ? requested : spec.requiredFields) || [];
    const missing = requiredSet.filter((f) => !(f in obj));
    if (missing.length) {
      throw new Error(`Missing required fields for ${p}: ${missing.join(', ')}`);
    }

    // Enum checks (top-level only)
    if (spec.enums) {
      for (const [field, allowed] of Object.entries(spec.enums)) {
        if (field in obj && obj[field] != null) {
          const val = String(obj[field]);
          if (!allowed.includes(val)) {
            throw new Error(`Invalid enum for ${p}.${field}: "${val}" not in [${allowed.join(', ')}]`);
          }
        }
      }
    }
  }
}


