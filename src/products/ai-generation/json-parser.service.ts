import { Injectable, Logger } from '@nestjs/common';
import { TypedGeneratedDetails, PlatformKey, ShopifyPlatformData, AmazonPlatformData, EbayPlatformData, WhatnotPlatformData, SquarePlatformData, FacebookPlatformData, CloverPlatformData } from '../types/generated-platform-types';

@Injectable()
export class JsonParserService {
  private readonly logger = new Logger(JsonParserService.name);

  /**
   * Main entry point for parsing AI responses into typed platform data
   */
  parseAIResponse(rawResponse: string, requestedPlatforms: string[] = []): TypedGeneratedDetails | null {
    try {
      this.logger.debug(`Parsing AI response, length: ${rawResponse.length}, platforms: ${requestedPlatforms.join(', ')}`);
      
      // Step 1: Clean and extract JSON
      const cleanedJson = this.extractCleanJSON(rawResponse);
      if (!cleanedJson) {
        this.logger.warn('Failed to extract valid JSON from AI response');
        return this.createFallbackResponse(requestedPlatforms, rawResponse);
      }

      // Step 2: Parse JSON safely
      let parsedData: any;
      try {
        parsedData = JSON.parse(cleanedJson);
      } catch (parseError) {
        this.logger.warn(`JSON parse failed: ${parseError.message}, attempting recovery`);
        const recovered = this.attemptJSONRecovery(cleanedJson);
        if (!recovered) {
          return this.createFallbackResponse(requestedPlatforms, rawResponse);
        }
        parsedData = recovered;
      }

      // Step 3: Validate and type the data
      const typedResult = this.validateAndTypePlatformData(parsedData, requestedPlatforms);
      
      this.logger.log(`Successfully parsed AI response with ${Object.keys(typedResult).length} platforms`);
      return typedResult;

    } catch (error) {
      this.logger.error(`Error parsing AI response: ${error.message}`, error.stack);
      return this.createFallbackResponse(requestedPlatforms, rawResponse);
    }
  }

  /**
   * Extract and clean JSON from AI response with multiple strategies
   */
  private extractCleanJSON(text: string): string | null {
    if (!text) return null;

    // Remove thinking blocks
    let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    
    // Strategy 1: Look for fenced code blocks
    const fencedPatterns = [
      /```json\s*([\s\S]*?)\s*```/i,
      /```\s*([\s\S]*?)\s*```/i,
    ];
    
    for (const pattern of fencedPatterns) {
      const match = cleaned.match(pattern);
      if (match && match[1]) {
        const extracted = match[1].trim();
        if (this.looksLikeJSON(extracted)) {
          return extracted;
        }
      }
    }

    // Strategy 2: Find JSON object boundaries
    const jsonStart = cleaned.indexOf('{');
    const jsonEnd = this.findMatchingBrace(cleaned, jsonStart);
    
    if (jsonStart !== -1 && jsonEnd !== -1) {
      const extracted = cleaned.substring(jsonStart, jsonEnd + 1);
      if (this.looksLikeJSON(extracted)) {
        return extracted;
      }
    }

    // Strategy 3: Try to find any JSON-like structure
    const jsonLikeMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonLikeMatch) {
      return jsonLikeMatch[0];
    }

    return null;
  }

  /**
   * Find matching closing brace using bracket counting
   */
  private findMatchingBrace(text: string, startIndex: number): number {
    if (startIndex === -1 || text[startIndex] !== '{') return -1;
    
    let braceCount = 0;
    let inString = false;
    let escapeNext = false;
    
    for (let i = startIndex; i < text.length; i++) {
      const char = text[i];
      
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      
      if (char === '\\') {
        escapeNext = true;
        continue;
      }
      
      if (char === '"' && !escapeNext) {
        inString = !inString;
        continue;
      }
      
      if (!inString) {
        if (char === '{') braceCount++;
        if (char === '}') braceCount--;
        
        if (braceCount === 0) {
          return i;
        }
      }
    }
    
    return -1;
  }

  /**
   * Quick validation if text looks like JSON
   */
  private looksLikeJSON(text: string): boolean {
    const trimmed = text.trim();
    return (trimmed.startsWith('{') && trimmed.includes(':')) ||
           (trimmed.startsWith('[') && trimmed.includes('{'));
  }

  /**
   * Attempt to recover malformed JSON with multiple strategies
   */
  private attemptJSONRecovery(malformedJson: string): any | null {
    // Strategy 1: Basic cleanup and fixes
    try {
      let fixed = malformedJson
        .replace(/,(\s*[}\]])/g, '$1')  // Remove trailing commas
        .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')  // Quote unquoted keys
        .replace(/:\s*'([^']*)'/g, ': "$1"')  // Convert single quotes to double
        .replace(/\\'/g, "'")  // Fix escaped single quotes
        .replace(/\n/g, ' ')  // Remove newlines
        .replace(/\t/g, ' ')  // Remove tabs
        .replace(/\s+/g, ' ');  // Normalize whitespace

      return JSON.parse(fixed);
    } catch (error) {
      this.logger.debug(`Strategy 1 failed: ${error.message}`);
    }

    // Strategy 2: Find the largest valid JSON object by truncating at error position
    try {
      const errorMatch = malformedJson.match(/at position (\d+)/);
      if (errorMatch) {
        const errorPos = parseInt(errorMatch[1], 10);
        let truncated = malformedJson.substring(0, errorPos);
        
        // Try to close the JSON properly
        const openBraces = (truncated.match(/\{/g) || []).length;
        const closeBraces = (truncated.match(/\}/g) || []).length;
        const missingBraces = openBraces - closeBraces;
        
        if (missingBraces > 0) {
          truncated += '}'.repeat(missingBraces);
        }
        
        // Clean up any incomplete properties
        truncated = truncated.replace(/,\s*$/, '').replace(/:\s*$/, ': ""');
        
        return JSON.parse(truncated);
      }
    } catch (error) {
      this.logger.debug(`Strategy 2 failed: ${error.message}`);
    }

    // Strategy 3: Extract individual platform objects and rebuild
    try {
      const platformObjects: any = {};
      const platformNames = ['shopify', 'amazon', 'ebay', 'whatnot', 'square', 'facebook', 'clover'];
      
      for (const platform of platformNames) {
        const platformRegex = new RegExp(`"${platform}"\\s*:\\s*\\{([^}]+(?:\\{[^}]*\\}[^}]*)*)\\}`, 'i');
        const match = malformedJson.match(platformRegex);
        
        if (match) {
          try {
            const platformJson = `{"${platform}": {${match[1]}}}`;
            const parsed = JSON.parse(platformJson);
            platformObjects[platform] = parsed[platform];
          } catch (e) {
            // Skip this platform if it can't be parsed
            this.logger.debug(`Failed to extract ${platform}: ${e.message}`);
          }
        }
      }
      
      if (Object.keys(platformObjects).length > 0) {
        this.logger.debug(`Strategy 3 recovered ${Object.keys(platformObjects).length} platforms`);
        return platformObjects;
      }
    } catch (error) {
      this.logger.debug(`Strategy 3 failed: ${error.message}`);
    }

    // Strategy 4: Create minimal valid structure
    this.logger.warn('All JSON recovery strategies failed, returning minimal structure');
    return null;
  }

  /**
   * Validate and type platform data with comprehensive fallbacks
   */
  private validateAndTypePlatformData(data: any, requestedPlatforms: string[]): TypedGeneratedDetails {
    const result: TypedGeneratedDetails = {};

    // Handle case where data is not an object
    if (!data || typeof data !== 'object') {
      this.logger.warn('Parsed data is not an object, creating fallback');
      return this.createFallbackResponse(requestedPlatforms, '');
    }

    // Process each requested platform
    for (const platform of requestedPlatforms) {
      const platformKey = platform.toLowerCase() as PlatformKey;
      const platformData = data[platformKey] || data[platform];

      if (platformData) {
        try {
          result[platformKey] = this.validatePlatformData(platformKey, platformData);
        } catch (error) {
          this.logger.warn(`Failed to validate ${platformKey} data: ${error.message}`);
          result[platformKey] = this.createEmptyPlatformData(platformKey);
        }
      } else {
        this.logger.warn(`No data found for platform: ${platformKey}`);
        result[platformKey] = this.createEmptyPlatformData(platformKey);
      }
    }

    return result;
  }

  /**
   * Validate individual platform data
   */
  private validatePlatformData(platform: PlatformKey, data: any): any {
    if (!data || typeof data !== 'object') {
      return this.createEmptyPlatformData(platform);
    }

    // Platform-specific validation and cleanup
    switch (platform) {
      case 'shopify':
        return this.validateShopifyData(data);
      case 'amazon':
        return this.validateAmazonData(data);
      case 'ebay':
        return this.validateEbayData(data);
      case 'whatnot':
        return this.validateWhatnotData(data);
      case 'square':
        return this.validateSquareData(data);
      case 'facebook':
        return this.validateFacebookData(data);
      case 'clover':
        return this.validateCloverData(data);
      default:
        return data;
    }
  }

  private validateShopifyData(data: any): ShopifyPlatformData {
    return {
      title: typeof data.title === 'string' ? data.title : undefined,
      description: typeof data.description === 'string' ? data.description : undefined,
      vendor: typeof data.vendor === 'string' ? data.vendor : undefined,
      productCategory: typeof data.productCategory === 'string' ? data.productCategory : undefined,
      productType: typeof data.productType === 'string' ? data.productType : undefined,
      tags: Array.isArray(data.tags) ? data.tags.filter(t => typeof t === 'string') : undefined,
      status: ['active', 'draft', 'archived'].includes(data.status) ? data.status : 'draft',
      variants: Array.isArray(data.variants) ? data.variants.map(v => this.validateShopifyVariant(v)) : undefined,
      images: Array.isArray(data.images) ? data.images.map(i => this.validateShopifyImage(i)) : undefined,
      publishedOnOnlineStore: typeof data.publishedOnOnlineStore === 'boolean' ? data.publishedOnOnlineStore : true,
      giftCard: typeof data.giftCard === 'boolean' ? data.giftCard : false,
      seo: data.seo ? this.validateShopifySEO(data.seo) : undefined,
      googleShopping: data.googleShopping ? this.validateShopifyGoogleShopping(data.googleShopping) : undefined,
    };
  }

  private validateShopifyVariant(data: any): any {
    if (!data || typeof data !== 'object') return {};
    
    return {
      option1_name: typeof data.option1_name === 'string' ? data.option1_name : undefined,
      option1_value: typeof data.option1_value === 'string' ? data.option1_value : undefined,
      option2_name: typeof data.option2_name === 'string' ? data.option2_name : undefined,
      option2_value: typeof data.option2_value === 'string' ? data.option2_value : undefined,
      option3_name: typeof data.option3_name === 'string' ? data.option3_name : undefined,
      option3_value: typeof data.option3_value === 'string' ? data.option3_value : undefined,
      sku: typeof data.sku === 'string' ? data.sku : undefined,
      barcode: typeof data.barcode === 'string' ? data.barcode : undefined,
      price: typeof data.price === 'number' ? data.price : undefined,
      compareAtPrice: typeof data.compareAtPrice === 'number' ? data.compareAtPrice : undefined,
      costPerItem: typeof data.costPerItem === 'number' ? data.costPerItem : undefined,
      chargeTax: typeof data.chargeTax === 'boolean' ? data.chargeTax : true,
      taxCode: typeof data.taxCode === 'string' ? data.taxCode : undefined,
      inventoryTracker: typeof data.inventoryTracker === 'string' ? data.inventoryTracker : 'shopify',
      inventoryQuantity: typeof data.inventoryQuantity === 'number' ? data.inventoryQuantity : 0,
      continueSellingWhenOutOfStock: typeof data.continueSellingWhenOutOfStock === 'boolean' ? data.continueSellingWhenOutOfStock : false,
      weightValueGrams: typeof data.weightValueGrams === 'number' ? data.weightValueGrams : undefined,
      requiresShipping: typeof data.requiresShipping === 'boolean' ? data.requiresShipping : true,
      fulfillmentService: typeof data.fulfillmentService === 'string' ? data.fulfillmentService : 'manual',
      variantImageURL: typeof data.variantImageURL === 'string' ? data.variantImageURL : undefined,
    };
  }

  private validateShopifyImage(data: any): any {
    if (!data || typeof data !== 'object') return {};
    
    return {
      productImageURL: typeof data.productImageURL === 'string' ? data.productImageURL : '',
      imagePosition: typeof data.imagePosition === 'number' ? data.imagePosition : 1,
      imageAltText: typeof data.imageAltText === 'string' ? data.imageAltText : undefined,
    };
  }

  private validateShopifySEO(data: any): any {
    if (!data || typeof data !== 'object') return {};
    
    return {
      seoTitle: typeof data.seoTitle === 'string' ? data.seoTitle : undefined,
      seoDescription: typeof data.seoDescription === 'string' ? data.seoDescription : undefined,
    };
  }

  private validateShopifyGoogleShopping(data: any): any {
    if (!data || typeof data !== 'object') return {};
    
    return {
      googleProductCategory: typeof data.googleProductCategory === 'string' ? data.googleProductCategory : undefined,
      gender: ['Unisex', 'Male', 'Female'].includes(data.gender) ? data.gender : 'Unisex',
      ageGroup: ['Adult', 'Kids', 'Toddler', 'Infant', 'Newborn'].includes(data.ageGroup) ? data.ageGroup : 'Adult',
      mpn: typeof data.mpn === 'string' ? data.mpn : undefined,
      adWordsGrouping: typeof data.adWordsGrouping === 'string' ? data.adWordsGrouping : undefined,
      adWordsLabels: typeof data.adWordsLabels === 'string' ? data.adWordsLabels : undefined,
      condition: ['new', 'refurbished', 'used'].includes(data.condition) ? data.condition : 'new',
      customProduct: typeof data.customProduct === 'boolean' ? data.customProduct : false,
      customLabel0: typeof data.customLabel0 === 'string' ? data.customLabel0 : undefined,
      customLabel1: typeof data.customLabel1 === 'string' ? data.customLabel1 : undefined,
      customLabel2: typeof data.customLabel2 === 'string' ? data.customLabel2 : undefined,
      customLabel3: typeof data.customLabel3 === 'string' ? data.customLabel3 : undefined,
      customLabel4: typeof data.customLabel4 === 'string' ? data.customLabel4 : undefined,
    };
  }

  private validateAmazonData(data: any): AmazonPlatformData {
    return {
      sku: typeof data.sku === 'string' ? data.sku : undefined,
      productId: typeof data.productId === 'string' ? data.productId : undefined,
      productIdType: ['UPC', 'EAN', 'GTIN', 'ASIN', 'ISBN'].includes(data.productIdType) ? data.productIdType : 'UPC',
      title: typeof data.title === 'string' ? data.title : undefined,
      brand: typeof data.brand === 'string' ? data.brand : undefined,
      manufacturer: typeof data.manufacturer === 'string' ? data.manufacturer : undefined,
      description: typeof data.description === 'string' ? data.description : undefined,
      bullet_points: Array.isArray(data.bullet_points) ? data.bullet_points.filter(p => typeof p === 'string') : undefined,
      search_terms: Array.isArray(data.search_terms) ? data.search_terms.filter(t => typeof t === 'string') : undefined,
      price: typeof data.price === 'number' ? data.price : undefined,
      quantity: typeof data.quantity === 'number' ? data.quantity : undefined,
      mainImageURL: typeof data.mainImageURL === 'string' ? data.mainImageURL : undefined,
      otherImageURLs: Array.isArray(data.otherImageURLs) ? data.otherImageURLs.filter(u => typeof u === 'string') : undefined,
      categorySuggestion: typeof data.categorySuggestion === 'string' ? data.categorySuggestion : undefined,
      amazonProductType: typeof data.amazonProductType === 'string' ? data.amazonProductType : undefined,
      condition: ['New', 'Used', 'Refurbished'].includes(data.condition) ? data.condition : 'New',
    };
  }

  private validateEbayData(data: any): EbayPlatformData {
    // Simplified validation for eBay - can be expanded
    return {
      action: typeof data.action === 'string' ? data.action : 'Add',
      customLabel: typeof data.customLabel === 'string' ? data.customLabel : undefined,
      category: typeof data.category === 'string' ? data.category : undefined,
      title: typeof data.title === 'string' ? data.title : undefined,
      description: typeof data.description === 'string' ? data.description : undefined,
      conditionID: typeof data.conditionID === 'number' ? data.conditionID : 1000,
      // Add more validation as needed
      ...data
    };
  }

  private validateWhatnotData(data: any): WhatnotPlatformData {
    return {
      category: typeof data.category === 'string' ? data.category : undefined,
      subCategory: typeof data.subCategory === 'string' ? data.subCategory : undefined,
      title: typeof data.title === 'string' ? data.title : undefined,
      description: typeof data.description === 'string' ? data.description : undefined,
      quantity: typeof data.quantity === 'number' ? data.quantity : 1,
      type: ['Buy it Now', 'Auction'].includes(data.type) ? data.type : 'Buy it Now',
      price: typeof data.price === 'number' ? data.price : undefined,
      shippingProfile: typeof data.shippingProfile === 'string' ? data.shippingProfile : undefined,
      offerable: typeof data.offerable === 'boolean' ? data.offerable : true,
      hazmat: ['Not Hazmat', 'Hazmat'].includes(data.hazmat) ? data.hazmat : 'Not Hazmat',
      condition: typeof data.condition === 'string' ? data.condition : undefined,
      costPerItem: typeof data.costPerItem === 'number' ? data.costPerItem : undefined,
      sku: typeof data.sku === 'string' ? data.sku : undefined,
      imageUrls: Array.isArray(data.imageUrls) ? data.imageUrls.filter(u => typeof u === 'string') : undefined,
    };
  }

  private validateSquareData(data: any): SquarePlatformData {
    return {
      object: data.object ? this.validateSquareObject(data.object) : undefined,
    };
  }

  private validateSquareObject(data: any): any {
    if (!data || typeof data !== 'object') return {};
    
    return {
      type: typeof data.type === 'string' ? data.type : 'ITEM',
      id: typeof data.id === 'string' ? data.id : '#placeholder',
      itemData: data.itemData ? this.validateSquareItemData(data.itemData) : undefined,
    };
  }

  private validateSquareItemData(data: any): any {
    if (!data || typeof data !== 'object') return {};
    
    return {
      name: typeof data.name === 'string' ? data.name : undefined,
      description: typeof data.description === 'string' ? data.description : undefined,
      categorySuggestion: typeof data.categorySuggestion === 'string' ? data.categorySuggestion : undefined,
      gtin: data.gtin === null ? null : (typeof data.gtin === 'string' ? data.gtin : undefined),
      variations: Array.isArray(data.variations) ? data.variations.map(v => this.validateSquareVariation(v)) : undefined,
      locations: typeof data.locations === 'string' ? data.locations : 'All Available Locations',
    };
  }

  private validateSquareVariation(data: any): any {
    if (!data || typeof data !== 'object') return {};
    
    return {
      type: typeof data.type === 'string' ? data.type : 'ITEM_VARIATION',
      id: typeof data.id === 'string' ? data.id : '#placeholder_variant',
      itemVariationData: data.itemVariationData ? this.validateSquareItemVariationData(data.itemVariationData) : undefined,
    };
  }

  private validateSquareItemVariationData(data: any): any {
    if (!data || typeof data !== 'object') return {};
    
    return {
      sku: typeof data.sku === 'string' ? data.sku : undefined,
      name: typeof data.name === 'string' ? data.name : 'Regular',
      pricingType: typeof data.pricingType === 'string' ? data.pricingType : 'FIXED_PRICING',
      priceMoney: data.priceMoney ? {
        amount: typeof data.priceMoney.amount === 'number' ? data.priceMoney.amount : 0,
        currency: typeof data.priceMoney.currency === 'string' ? data.priceMoney.currency : 'USD',
      } : undefined,
    };
  }

  private validateFacebookData(data: any): FacebookPlatformData {
    return {
      id: typeof data.id === 'string' ? data.id : undefined,
      title: typeof data.title === 'string' ? data.title : undefined,
      description: typeof data.description === 'string' ? data.description : undefined,
      availability: ['in stock', 'out of stock', 'available for order'].includes(data.availability) ? data.availability : 'in stock',
      condition: ['new', 'refurbished', 'used'].includes(data.condition) ? data.condition : 'new',
      price: typeof data.price === 'string' ? data.price : undefined,
      link: typeof data.link === 'string' ? data.link : undefined,
      image_link: typeof data.image_link === 'string' ? data.image_link : undefined,
      brand: typeof data.brand === 'string' ? data.brand : undefined,
      google_product_category: typeof data.google_product_category === 'string' ? data.google_product_category : undefined,
      categorySuggestion: typeof data.categorySuggestion === 'string' ? data.categorySuggestion : undefined,
    };
  }

  private validateCloverData(data: any): CloverPlatformData {
    return {
      name: typeof data.name === 'string' ? data.name : undefined,
      price: typeof data.price === 'number' ? data.price : undefined,
      priceType: ['FIXED', 'VARIABLE'].includes(data.priceType) ? data.priceType : 'FIXED',
      sku: typeof data.sku === 'string' ? data.sku : undefined,
      category: data.category ? {
        name: typeof data.category.name === 'string' ? data.category.name : undefined,
      } : undefined,
      modifierGroups: Array.isArray(data.modifierGroups) ? data.modifierGroups : [],
      availability: ['in stock', 'out of stock'].includes(data.availability) ? data.availability : 'in stock',
      brand: typeof data.brand === 'string' ? data.brand : undefined,
    };
  }

  /**
   * Create empty platform data for a given platform
   */
  private createEmptyPlatformData(platform: PlatformKey): any {
    switch (platform) {
      case 'shopify':
        return { status: 'draft' };
      case 'amazon':
        return { condition: 'New' };
      case 'ebay':
        return { action: 'Add', conditionID: 1000 };
      case 'whatnot':
        return { type: 'Buy it Now', quantity: 1, hazmat: 'Not Hazmat' };
      case 'square':
        return { object: { type: 'ITEM', id: '#placeholder' } };
      case 'facebook':
        return { availability: 'in stock', condition: 'new' };
      case 'clover':
        return { priceType: 'FIXED', availability: 'in stock', modifierGroups: [] };
      default:
        return {};
    }
  }

  /**
   * Create fallback response when parsing completely fails
   */
  private createFallbackResponse(requestedPlatforms: string[], rawResponse: string = ''): TypedGeneratedDetails {
    const result: TypedGeneratedDetails = {};
    
    for (const platform of requestedPlatforms) {
      const platformKey = platform.toLowerCase() as PlatformKey;
      const fallbackData = this.createEmptyPlatformData(platformKey);
      
      // Add raw response for debugging and manual extraction
      if (rawResponse) {
        (fallbackData as any)._rawResponse = rawResponse;
        (fallbackData as any)._parseError = 'Failed to parse AI response';
        (fallbackData as any).title = 'Generated Product (Parse Failed)';
        (fallbackData as any).description = 'AI response could not be parsed - raw data preserved for debugging';
      }
      
      result[platformKey] = fallbackData;
    }
    
    return result;
  }
}

