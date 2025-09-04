// Generated Platform Types - Comprehensive type definitions for AI-generated platform data

export interface ShopifyVariant {
  option1_name?: string;
  option1_value?: string;
  option2_name?: string;
  option2_value?: string;
  option3_name?: string;
  option3_value?: string;
  sku?: string;
  barcode?: string;
  price?: number;
  compareAtPrice?: number;
  costPerItem?: number;
  chargeTax?: boolean;
  taxCode?: string;
  inventoryTracker?: string;
  inventoryQuantity?: number;
  continueSellingWhenOutOfStock?: boolean;
  weightValueGrams?: number;
  requiresShipping?: boolean;
  fulfillmentService?: string;
  variantImageURL?: string;
}

export interface ShopifyImage {
  productImageURL: string;
  imagePosition: number;
  imageAltText?: string;
}

export interface ShopifySEO {
  seoTitle?: string;
  seoDescription?: string;
}

export interface ShopifyGoogleShopping {
  googleProductCategory?: string;
  gender?: 'Unisex' | 'Male' | 'Female';
  ageGroup?: 'Adult' | 'Kids' | 'Toddler' | 'Infant' | 'Newborn';
  mpn?: string;
  adWordsGrouping?: string;
  adWordsLabels?: string;
  condition?: 'new' | 'refurbished' | 'used';
  customProduct?: boolean;
  customLabel0?: string;
  customLabel1?: string;
  customLabel2?: string;
  customLabel3?: string;
  customLabel4?: string;
}

export interface ShopifyPlatformData {
  title?: string;
  description?: string;
  vendor?: string;
  productCategory?: string;
  productType?: string;
  tags?: string[];
  status?: 'active' | 'draft' | 'archived';
  variants?: ShopifyVariant[];
  images?: ShopifyImage[];
  publishedOnOnlineStore?: boolean;
  giftCard?: boolean;
  seo?: ShopifySEO;
  googleShopping?: ShopifyGoogleShopping;
}

export interface AmazonPlatformData {
  sku?: string;
  productId?: string;
  productIdType?: 'UPC' | 'EAN' | 'GTIN' | 'ASIN' | 'ISBN';
  title?: string;
  brand?: string;
  manufacturer?: string;
  description?: string;
  bullet_points?: string[];
  search_terms?: string[];
  price?: number;
  quantity?: number;
  mainImageURL?: string;
  otherImageURLs?: string[];
  categorySuggestion?: string;
  amazonProductType?: 'BEAUTY' | 'KITCHEN' | 'TOOLS_AND_HOME_IMPROVEMENT' | 'CLOTHING_SHOES_AND_JEWELRY' | 'COLLECTIBLES' | 'BOOKS' | 'HEALTH_PERSONAL_CARE' | 'ELECTRONICS' | 'SPORTS_OUTDOORS' | 'TOYS_AND_GAMES';
  condition?: 'New' | 'Used' | 'Refurbished';
}

export interface EbayConditionDetails {
  professionalGrader?: string;
  grade?: string;
  certificationNumber?: string;
  cardCondition?: string;
}

export interface EbayItemSpecifics {
  brand?: string;
  type?: string;
  size?: string;
  color?: string;
  style?: string;
  [key: string]: string | undefined;
}

export interface EbayMedia {
  picURL?: string;
  galleryType?: string;
  videoID?: string;
}

export interface EbayListingDetails {
  format?: 'FixedPrice' | 'Auction';
  duration?: string;
  startPrice?: number;
  buyItNowPrice?: number;
  bestOfferEnabled?: boolean;
  bestOfferAutoAcceptPrice?: number;
  minimumBestOfferPrice?: number;
  quantity?: number;
  immediatePayRequired?: boolean;
  location?: string;
}

export interface EbayShippingService {
  option?: string;
  cost?: number;
}

export interface EbayShippingDetails {
  shippingType?: string;
  dispatchTimeMax?: number;
  promotionalShippingDiscount?: boolean;
  shippingDiscountProfileID?: string;
  services?: EbayShippingService[];
}

export interface EbayReturnPolicy {
  returnsAcceptedOption?: string;
  returnsWithinOption?: string;
  refundOption?: string;
  shippingCostPaidByOption?: string;
  additionalDetails?: string;
}

export interface EbayProductSafety {
  productSafetyPictograms?: string;
  productSafetyStatements?: string;
  productSafetyComponent?: string;
  regulatoryDocumentIds?: string;
}

export interface EbayManufacturerDetails {
  manufacturerName?: string;
  manufacturerAddressLine1?: string;
  manufacturerAddressLine2?: string;
  manufacturerCity?: string;
  manufacturerCountry?: string;
  manufacturerPostalCode?: string;
  manufacturerStateOrProvince?: string;
  manufacturerPhone?: string;
  manufacturerEmail?: string;
  manufacturerContactURL?: string;
}

export interface EbayResponsiblePerson {
  type?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  country?: string;
  postalCode?: string;
  stateOrProvince?: string;
  phone?: string;
  email?: string;
  contactURL?: string;
}

export interface EbayPlatformData {
  action?: string;
  customLabel?: string;
  category?: string;
  storeCategory?: string;
  title?: string;
  subtitle?: string;
  relationship?: string;
  relationshipDetails?: string;
  scheduleTime?: string;
  conditionID?: number;
  conditionDetails?: EbayConditionDetails;
  itemSpecifics?: EbayItemSpecifics;
  media?: EbayMedia;
  description?: string;
  listingDetails?: EbayListingDetails;
  shippingDetails?: EbayShippingDetails;
  returnPolicy?: EbayReturnPolicy;
  productSafety?: EbayProductSafety;
  manufacturerDetails?: EbayManufacturerDetails;
  responsiblePerson?: EbayResponsiblePerson;
}

export interface WhatnotPlatformData {
  category?: string;
  subCategory?: string;
  title?: string;
  description?: string;
  quantity?: number;
  type?: 'Buy it Now' | 'Auction';
  price?: number;
  shippingProfile?: string;
  offerable?: boolean;
  hazmat?: 'Not Hazmat' | 'Hazmat';
  condition?: string;
  costPerItem?: number;
  sku?: string;
  imageUrls?: string[];
}

export interface SquareItemVariationData {
  sku?: string;
  name?: string;
  pricingType?: string;
  priceMoney?: {
    amount?: number;
    currency?: string;
  };
}

export interface SquareItemVariation {
  type?: string;
  id?: string;
  itemVariationData?: SquareItemVariationData;
}

export interface SquareItemData {
  name?: string;
  description?: string;
  categorySuggestion?: string;
  gtin?: string | null;
  variations?: SquareItemVariation[];
  locations?: string;
}

export interface SquareObject {
  type?: string;
  id?: string;
  itemData?: SquareItemData;
}

export interface SquarePlatformData {
  object?: SquareObject;
}

export interface FacebookPlatformData {
  id?: string;
  title?: string;
  description?: string;
  availability?: 'in stock' | 'out of stock' | 'available for order';
  condition?: 'new' | 'refurbished' | 'used';
  price?: string;
  link?: string;
  image_link?: string;
  brand?: string;
  google_product_category?: string;
  categorySuggestion?: string;
}

export interface CloverCategory {
  name?: string;
}

export interface CloverPlatformData {
  name?: string;
  price?: number;
  priceType?: 'FIXED' | 'VARIABLE';
  sku?: string;
  category?: CloverCategory;
  modifierGroups?: any[];
  availability?: 'in stock' | 'out of stock';
  brand?: string;
}

// Union type for all platform data
export type PlatformData = 
  | ShopifyPlatformData 
  | AmazonPlatformData 
  | EbayPlatformData 
  | WhatnotPlatformData 
  | SquarePlatformData 
  | FacebookPlatformData 
  | CloverPlatformData;

// Main interface for generated details
export interface TypedGeneratedDetails {
  shopify?: ShopifyPlatformData;
  amazon?: AmazonPlatformData;
  ebay?: EbayPlatformData;
  whatnot?: WhatnotPlatformData;
  square?: SquarePlatformData;
  facebook?: FacebookPlatformData;
  clover?: CloverPlatformData;
}

// Platform keys
export type PlatformKey = keyof TypedGeneratedDetails;

// Helper type to get platform data type by key
export type PlatformDataByKey<K extends PlatformKey> = TypedGeneratedDetails[K];

