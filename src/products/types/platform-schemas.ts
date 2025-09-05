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
    requiredFields: ['title', 'description', 'price', 'productIdType'],
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

const schemas = {
  shopify: {
    title: "",
    "description": "...",
    "vendor": "...",
    "productCategory": "...",
    "productType": "...",
    "tags": ["...", "..."],
    "status": "active",
    "variants": [
      {
        "option1_name": "Size",
        "option1_value": "Large",
        "option2_name": "Color",
        "option2_value": "Red",
        "option3_name": "",
        "option3_value": "",
        "sku": "...",
        "barcode": "...",
        "price": 0.00,
        "compareAtPrice": 0.00,
        "costPerItem": 0.00,
        "chargeTax": true,
        "taxCode": "",
        "inventoryTracker": "shopify",
        "inventoryQuantity": 0,
        "continueSellingWhenOutOfStock": false,
        "weightValueGrams": 0,
        "requiresShipping": true,
        "fulfillmentService": "manual",
        "variantImageURL": "https://..."
      }
    ],
    "images": [
      {
        "productImageURL": "https://...",
        "imagePosition": 1,
        "imageAltText": "..."
      }
    ],
    "publishedOnOnlineStore": true,
    "giftCard": false,
    "seo": {
      "seoTitle": "...",
      "seoDescription": "..."
    },
    "googleShopping": {
      "googleProductCategory": "...",
      "gender": "Unisex",
      "ageGroup": "Adult",
      "mpn": "...",
      "adWordsGrouping": "",
      "adWordsLabels": "",
      "condition": "new",
      "customProduct": false,
      "customLabel0": "",
      "customLabel1": "",
      "customLabel2": "",
      "customLabel3": "",
      "customLabel4": ""
    }
  },
  "amazon": {
    "sku": "...",
    "productId": "...",
    "productIdType": "UPC",
    "title": "...",
    "brand": "...",
    "manufacturer": "...",
    "description": "...",
    "bullet_points": [
      "...",
      "...",
      "..."
    ],
    "search_terms": [
      "...",
      "..."
    ],
    "price": 0.00,
    "quantity": 0,
    "mainImageURL": "https://...",
    "otherImageURLs": [],
    "categorySuggestion": "...",
    "amazonProductType": "COLLECTIBLES",
    "condition": "New"
  },
  "ebay": {
    "action": "Add",
    "customLabel": "...",
    "category": "...",
    "storeCategory": "",
    "title": "...",
    "subtitle": "",
    "relationship": "",
    "relationshipDetails": "",
    "scheduleTime": "",
    "conditionID": 1000,
    "conditionDetails": {
      "professionalGrader": "",
      "grade": "",
      "certificationNumber": "",
      "cardCondition": "Near mint or better"
    },
    "itemSpecifics": {
      "brand": "...",
      "type": "...",
      "size": "...",
      "color": "...",
      "style": "..."
    },
    "media": {
      "picURL": "https://...",
      "galleryType": "Gallery",
      "videoID": ""
    },
    "description": "...",
    "listingDetails": {
      "format": "FixedPrice",
      "duration": "GTC",
      "startPrice": 0.00,
      "buyItNowPrice": 0.00,
      "bestOfferEnabled": false,
      "bestOfferAutoAcceptPrice": 0,
      "minimumBestOfferPrice": 0,
      "quantity": 0,
      "immediatePayRequired": true,
      "location": "..."
    },
    "shippingDetails": {
      "shippingType": "Flat",
      "dispatchTimeMax": 1,
      "promotionalShippingDiscount": false,
      "shippingDiscountProfileID": "",
      "services": [
        {
          "option": "USPS Ground Advantage",
          "cost": 0.00
        }
      ]
    },
    "returnPolicy": {
      "returnsAcceptedOption": "ReturnsAccepted",
      "returnsWithinOption": "Days_30",
      "refundOption": "MoneyBack",
      "shippingCostPaidByOption": "Buyer",
      "additionalDetails": ""
    },
    "productSafety": {
      "productSafetyPictograms": "",
      "productSafetyStatements": "",
      "productSafetyComponent": "",
      "regulatoryDocumentIds": ""
    },
    "manufacturerDetails": {
      "manufacturerName": "",
      "manufacturerAddressLine1": "",
      "manufacturerAddressLine2": "",
      "manufacturerCity": "",
      "manufacturerCountry": "",
      "manufacturerPostalCode": "",
      "manufacturerStateOrProvince": "",
      "manufacturerPhone": "",
      "manufacturerEmail": "",
      "manufacturerContactURL": ""
    },
    "responsiblePerson": {
      "type": "",
      "addressLine1": "",
      "addressLine2": "",
      "city": "",
      "country": "",
      "postalCode": "",
      "stateOrProvince": "",
      "phone": "",
      "email": "",
      "contactURL": ""
    }
  },
  "whatnot": {
    "category": "...",
    "subCategory": "...",
    "title": "...",
    "description": "...",
    "quantity": 1,
    "type": "Buy it Now",
    "price": 0.00,
    "shippingProfile": "0-1 oz",
    "offerable": true,
    "hazmat": "Not Hazmat",
    "condition": "Near Mint",
    "costPerItem": 0.00,
    "sku": "...",
    "imageUrls": ["https://..."]
  },
  "square": {
    "object": {
      "type": "ITEM",
      "id": "#placeholder",
      "itemData": {
        "name": "...",
        "description": "...",
        "categorySuggestion": "...",
        "gtin": null,
        "variations": [
          {
            "type": "ITEM_VARIATION",
            "id": "#placeholder_variant",
            "itemVariationData": {
              "sku": "...",
              "name": "Regular",
              "pricingType": "FIXED_PRICING",
              "priceMoney": {
                "amount": 0,
                "currency": "USD"
              }
            }
          }
        ],
        "locations": "All Available Locations"
      }
    }
  },
  "facebook": {
    "id": "...",
    "title": "...",
    "description": "...",
    "availability": "in stock",
    "condition": "new",
    "price": "0.00 USD",
    "link": "https://...",
    "image_link": "https://...",
    "brand": "...",
    "google_product_category": "...",
    "categorySuggestion": "..."
  },
  "clover": {
    "name": "...",
    "price": 0,
    "priceType": "FIXED",
    "sku": "...",
    "category": {
      "name": "..."
    },
    "modifierGroups": [],
    "availability": "in stock",
    "brand": "..."
  }
}

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
    
    // For now, make validation lenient - log warnings instead of throwing errors
    // This allows AI generation to proceed even with missing required fields
    if (missing.length) {
      console.warn(`[Platform Validation] Warning: Missing required fields for ${p}: ${missing.join(', ')}. Generated data may be incomplete.`);
      // TODO: In the future, provide fallback values or improve AI prompts
      // throw new Error(`Missing required fields for ${p}: ${missing.join(', ')}`);
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


