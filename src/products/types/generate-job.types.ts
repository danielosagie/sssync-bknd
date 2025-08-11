export interface GenerateJobData {
  type: 'generate-job';
  jobId: string;
  userId: string;
  products: Array<{
    productIndex: number;
    productId?: string;
    variantId?: string;
    imageUrls: string[];
    coverImageIndex: number;
    selectedMatches?: Array<any>; // SerpAPI selections or structured picks
  }>;
  selectedPlatforms: string[]; // e.g., ['shopify', 'amazon']
  template?: string | null;
  // Optional: fine-grained per-platform field source guidance from the template modal
  platformRequests?: Array<{
    platform: string;
    fieldSources?: Record<string, string[]>; // field -> preferred source domains/urls in order
    customPrompt?: string;
    requestedFields?: string[]; // additive hard-fail set: only generate these fields
  }>;
  // Optional: top-level sources list from the template (domains/urls)
  templateSources?: string[];
  options?: {
    useScraping?: boolean; // whether to scrape sources before generation
  };
  metadata: {
    totalProducts: number;
    estimatedTimeMinutes: number;
    createdAt: string;
  };
}

export interface GeneratedPlatformSpecificDetails {
  title?: string;
  description?: string;
  price?: number;
  compareAtPrice?: number;
  categorySuggestion?: string;
  tags?: string[] | string;
  brand?: string;
  condition?: string;
  // Platform-specific, open-ended structure allowed
  [key: string]: any;
}

export interface GenerateJobResult {
  productIndex: number;
  productId?: string;
  variantId?: string;
  platforms: Record<string, GeneratedPlatformSpecificDetails>;
  sourceImageUrl: string;
  processingTimeMs: number;
  source?: 'ai_generated' | 'scraped_content' | 'hybrid';
  error?: string;
}

export interface GenerateJobStatus {
  jobId: string;
  userId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  currentStage:
    | 'Preparing'
    | 'Fetching sources'
    | 'Scraping sources'
    | 'Generating details'
    | 'Saving drafts'
    | 'Ready';
  progress: {
    totalProducts: number;
    completedProducts: number;
    currentProductIndex?: number;
    failedProducts: number;
    stagePercentage: number;
  };
  results: GenerateJobResult[];
  summary?: {
    totalProducts: number;
    completed: number;
    failed: number;
    averageProcessingTimeMs?: number;
  };
  error?: string;
  startedAt: string;
  completedAt?: string;
  estimatedCompletionAt?: string;
  updatedAt: string;
}



// ===================================================================
// Shopify Interface
// ===================================================================

export interface ShopifyImage {
  productImageURL: string;
  imagePosition: number;
  imageAltText: string;
}

export interface ShopifyVariant {
  option1_name: string;
  option1_value: string;
  option2_name: string;
  option2_value: string;
  option3_name: string;
  option3_value: string;
  sku: string;
  barcode: string;
  price: number;
  compareAtPrice: number;
  costPerItem: number;
  chargeTax: boolean;
  taxCode: string;
  inventoryTracker: string;
  inventoryQuantity: number;
  continueSellingWhenOutOfStock: boolean;
  weightValueGrams: number;
  requiresShipping: boolean;
  fulfillmentService: string;
  variantImageURL: string;
}

export interface ShopifySeo {
  seoTitle: string;
  seoDescription: string;
}

export interface ShopifyGoogleShopping {
  googleProductCategory: string;
  gender: string;
  ageGroup: string;
  mpn: string;
  adWordsGrouping: string;
  adWordsLabels: string;
  condition: string;
  customProduct: boolean;
  customLabel0: string;
  customLabel1: string;
  customLabel2: string;
  customLabel3: string;
  customLabel4: string;
}

export interface Shopify {
  title: string;
  description: string;
  vendor: string;
  productCategory: string;
  productType: string;
  tags: string[];
  status: 'active' | 'draft' | 'archived';
  variants: ShopifyVariant[];
  images: ShopifyImage[];
  publishedOnOnlineStore: boolean;
  giftCard: boolean;
  seo: ShopifySeo;
  googleShopping: ShopifyGoogleShopping;
}


// ===================================================================
// Amazon Interface
// ===================================================================

export interface Amazon {
  sku: string;
  productId: string;
  productIdType: 'UPC' | 'EAN' | 'GTIN' | 'ASIN' | 'ISBN';
  title: string;
  brand: string;
  manufacturer: string;
  description: string;
  bullet_points: string[];
  search_terms: string[];
  price: number;
  quantity: number;
  mainImageURL: string;
  otherImageURLs: string[];
  categorySuggestion: string;
  amazonProductType: string; // e.g., "BOOKS"
  condition: 'New' | 'Used' | 'Refurbished';
}


// ===================================================================
// eBay Interface
// ===================================================================

export interface EbayConditionDetails {
  professionalGrader: string;
  grade: string;
  certificationNumber: string;
  cardCondition: string;
}

export interface EbayItemSpecifics {
  set?: string;
  franchise?: string;
  manufacturer?: string;
  configuration?: string;
  numberOfCards?: number;
  numberOfCases?: number;
  type?: string;
  yearManufactured?: number;
  character?: string;
  tvShow?: string;
  movie?: string;
  language?: string;
  ageLevel?: string;
  autographAuthentication?: string;
  genre?: string;
  countryRegionOfManufacture?: string;
  features?: string[];
  vintage?: boolean;
  material?: string;
  autographed?: boolean;
  cardSize?: string;
  mpn?: string;
  signedBy?: string;
  autographAuthenticationNumber?: string;
  autographFormat?: string;
  californiaProp65Warning?: string;
  conventionEvent?: string;
  featuredPersonArtist?: string;
  illustrator?: string;
  grade?: number;
  numberOfPacks?: number;
  brand?: string;
  size?: string;
  style?: string;
  sizeType?: string;
  color?: string;
  department?: string;
  fabricWash?: string;
  accents?: string;
  pattern?: string;
  fit?: string;
  rise?: string;
  fabricType?: string;
  inseam?: string;
  waistSize?: string;
  closure?: string;
  theme?: string;
  model?: string;
  productLine?: string;
  handmade?: boolean;
  personalize?: boolean;
  season?: string;
  garmentCare?: string;
  pocketType?: string;
  personalizationInstructions?: string;
  unitQuantity?: number;
  unitType?: string;
  parallelVariety?: string;
  cardNumber?: string;
  cardName?: string;
  graded?: boolean;
  originalLicensedReprint?: string;
  cardThickness?: string;
  insertSet?: string;
  printRun?: string;
  format?: string;
  focusType?: string;
  series?: string;
  manufacturerWarranty?: string;
  itemWeight?: string;
  itemHeight?: string;
  itemLength?: string;
  itemWidth?: string;
}

export interface EbayMedia {
  picURL: string;
  galleryType: string;
  videoID: string;
}

export interface EbayListingDetails {
  format: 'FixedPrice' | 'Auction';
  duration: string; // "GTC" for Good 'Til Canceled
  startPrice: number;
  buyItNowPrice?: number;
  bestOfferEnabled: boolean;
  bestOfferAutoAcceptPrice?: number;
  minimumBestOfferPrice?: number;
  quantity: number;
  immediatePayRequired: boolean;
  location: string;
}

export interface EbayShippingService {
  option: string;
  cost: number;
}

export interface EbayShippingDetails {
  shippingType: string;
  dispatchTimeMax: number;
  promotionalShippingDiscount: boolean;
  shippingDiscountProfileID: string;
  services: EbayShippingService[];
}

export interface EbayReturnPolicy {
  returnsAcceptedOption: string;
  returnsWithinOption: string;
  refundOption: string;
  shippingCostPaidByOption: string;
  additionalDetails: string;
}

export interface EbayProductSafety {
  productSafetyPictograms: string;
  productSafetyStatements: string;
  productSafetyComponent: string;
  regulatoryDocumentIds: string;
}

export interface EbayContactDetails {
  name?: string; // Added for clarity
  addressLine1: string;
  addressLine2: string;
  city: string;
  country: string;
  postalCode: string;
  stateOrProvince: string;
  phone: string;
  email: string;
  contactURL: string;
}

export interface EbayResponsiblePerson extends EbayContactDetails {
  type: string;
}

export interface Ebay {
  action: 'Add' | 'Revise' | 'End' | 'Verify';
  customLabel: string;
  category: string;
  storeCategory: string;
  title: string;
  subtitle: string;
  relationship: string;
  relationshipDetails: string;
  scheduleTime: string; // ISO 8601 format
  conditionID: number;
  conditionDetails: EbayConditionDetails;
  itemSpecifics: EbayItemSpecifics;
  media: EbayMedia;
  description: string;
  listingDetails: EbayListingDetails;
  shippingDetails: EbayShippingDetails;
  returnPolicy: EbayReturnPolicy;
  productSafety: EbayProductSafety;
  manufacturerDetails: EbayContactDetails;
  responsiblePerson: EbayResponsiblePerson;
}


// ===================================================================
// Whatnot Interface
// ===================================================================

export interface Whatnot {
  category: string;
  subCategory: string;
  title: string;
  description: string;
  quantity: number;
  type: 'Buy it Now' | 'Auction';
  price: number;
  shippingProfile: string;
  offerable: boolean;
  hazmat: 'Not Hazmat' | 'Hazmat';
  condition: string;
  costPerItem: number;
  sku: string;
  imageUrls: string[];
}


// ===================================================================
// Square Interface
// ===================================================================

export interface SquarePriceMoney {
  amount: number; // In cents
  currency: 'USD' | string;
}

export interface SquareItemVariationData {
  sku: string;
  name: string;
  pricingType: 'FIXED_PRICING' | 'VARIABLE_PRICING';
  priceMoney: SquarePriceMoney;
}

export interface SquareVariation {
  type: 'ITEM_VARIATION';
  id: string; // Placeholder like "#" or actual ID
  itemVariationData: SquareItemVariationData;
}

export interface SquareItemData {
  name: string;
  description: string;
  categorySuggestion: string;
  gtin: string | null;
  variations: SquareVariation[];
  locations: string; // e.g., "All Available Locations"
}

export interface Square {
  object: {
    type: 'ITEM';
    id: string; // Placeholder like "#" or actual ID
    itemData: SquareItemData;
  };
}


// ===================================================================
// Facebook Interface
// ===================================================================

export interface Facebook {
  id: string; // Corresponds to SKU
  title: string;
  description: string;
  availability: 'in stock' | 'out of stock' | 'available for order';
  condition: 'new' | 'refurbished' | 'used';
  price: string; // e.g., "9.99 USD"
  link: string; // Link to the product on your own website
  image_link: string;
  brand: string;
  google_product_category: string;
  categorySuggestion: string;
}


// ===================================================================
// Clover Interface
// ===================================================================

export interface CloverCategory {
  name: string;
}

export interface Clover {
  name: string;
  price: number;
  priceType: 'FIXED' | 'VARIABLE';
  sku: string;
  category: CloverCategory;
  modifierGroups: any[]; // Use `any` for maximum flexibility or define a specific ModifierGroup interface
  availability: 'in stock' | 'out of stock';
  brand: string;
}

