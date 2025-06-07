import { Injectable, Logger, InternalServerErrorException, UnauthorizedException, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlatformConnection, PlatformConnectionsService } from '../../platform-connections/platform-connections.service'; // Adjust path
import {
    shopifyApi,
    LATEST_API_VERSION,
    Shopify,
    Session,
    ApiVersion,
    GraphqlClient,
    // RestClient, // Keep if REST client is also needed
} from '@shopify/shopify-api';
import '@shopify/shopify-api/adapters/node'; // Import Node adapter

// Interface for the expected structure of decrypted credentials
interface ShopifyCredentials {
    accessToken: string;
    // Include other relevant fields if stored, e.g., scope
}

// --- Define interfaces for the expected data structures based on USER PROVIDED QUERY RESPONSE ---
export interface ShopifyLocationNode { // For the locations fetched by _fetchLocations
    id: string;
    name: string;
    isActive: boolean; // Assuming _fetchLocations will get this, or we align it.
}

// For the location part of the GetProductsByLocation query response
export interface ShopifySpecificLocationInfo { 
    id: string;
    name: string;
}

export interface ShopifyMediaImageNode {
    id: string;
    preview: {
        image: {
            url: string;
        };
    };
}

export interface ShopifyInventoryLevelLocationNode {
    id: string;
    name: string;
    isActive: boolean;
}

export interface ShopifyInventoryLevelNode {
    available: number;
    location: ShopifyInventoryLevelLocationNode;
}

export interface ShopifyInventoryItemNode {
    sku: string | null; // This is inventoryItem.sku
    measurement: {
        weight: {
            unit: string;
            value: number;
        } | null;
    } | null;
    inventoryLevels: {
        edges: {
            node: ShopifyInventoryLevelNode;
        }[];
        // pageInfo for inventoryLevels if we expect many per item/location combo
    };
    tracked?: boolean; // From our previous interface, user's query doesn't explicitly show it on inventoryItem but good to have if available
}

export interface ShopifyVariantNode {
    id: string;
    sku: string | null; // This is variant.sku
    barcode: string | null;
    compareAtPrice: string | null;
    createdAt: string; // Assuming string from GraphQL (ISO date)
    price: string;
    taxable: boolean;
    taxCode: string | null;
    inventoryQuantity: number; // Overall quantity for the variant across all locations
    inventoryItem: ShopifyInventoryItemNode;
    // image field was on variant node in our previous interface, user's query shows it under product.media
    // selectedOptions was on variant node, user's query doesn't show it on variant but good to keep if it can exist
    selectedOptions?: { name: string; value: string }[]; 
    weight?: number | null; // This was on variant in our old interface, now on inventoryItem.measurement.weight
    weightUnit?: string;  // Ditto
}

export interface ShopifyProductNode {
    id: string;
    title: string;
    status: string;
    descriptionHtml: string | null;
    tags: string[];
    media: {
        edges: {
            node: ShopifyMediaImageNode;
        }[];
        // pageInfo for media if needed
    };
    variants: {
        edges: {
            node: ShopifyVariantNode;
        }[];
        pageInfo?: { // For variants pagination per product
            hasNextPage: boolean;
            endCursor: string | null;
        };
    };
    totalInventory: number;
    tracksInventory: boolean;
    updatedAt: string; // Assuming string from GraphQL (ISO date)
    variantsCount: {
        count: number;
    };
    // Fields from our previous interface, check if they exist or are needed:
    handle?: string;
    vendor?: string;
    productType?: string;
    options?: { name: string; values: string[] }[];
    images?: { // This was separate from media in our old interface
        edges: {
            node: {
                id: string;
                url: string;
                altText: string;
            };
        }[];
    };
}
// --- End interface definitions ---

// +++ Add new interface for Product Overview +++
export interface ShopifyProductOverview {
    id: string;
    sku: string | null; // SKU of the first variant
    updatedAt: string;
    title: string; // Product title for logging/identification
}

// Types for Shopify GraphQL responses
interface ShopifyLocation {
    id: string;
    name: string;
    address: {
        formatted: string[];
    };
    isActive: boolean;
    createdAt: string;
}

interface ShopifyProductSetOperation {
    id: string;
    status: string;
    product: {
        id: string;
        title: string;
        status: string;
        options: Array<{
            name: string;
            values: string[];
        }>;
        media: {
            nodes: Array<{
                id: string;
                alt: string;
                mediaContentType: string;
                status: string;
                preview: {
                    image: {
                        url: string;
                    };
                };
            }>;
        };
        variants: {
            nodes: Array<{
                id: string;
                title: string;
                price: string;
                sku: string;
                media: {
                    nodes: Array<{
                        id: string;
                        alt: string;
                        mediaContentType: string;
                        status: string;
                        preview: {
                            image: {
                                url: string;
                            };
                        };
                    }>;
                };
            }>;
        };
    } | null;
    userErrors: Array<{
        field: string[] | null;
        message: string;
        code: string;
    }>;
}

export interface ShopifyProductOptionValue {
    name: string;
}

// Export this interface
export interface ShopifyProductOption {
    name: string;
    values: ShopifyProductOptionValue[];
}

export interface ShopifyProductFile {
    originalSource: string;
    alt?: string;
    filename: string;
    contentType: 'IMAGE' | 'VIDEO' | 'EXTERNAL_VIDEO' | 'MODEL_3D';
}

// Export this interface
export interface ShopifyInventoryQuantity {
    locationId: string;
    name: 'available' | 'committed';
    quantity: number;
}

// Export this interface
export interface ShopifyInventoryItem {
    cost?: string;
    tracked: boolean;
    measurement?: {
        weight: {
            value: number;
            unit: 'KILOGRAMS' | 'GRAMS' | 'POUNDS' | 'OUNCES';
        };
    };
}

// Export this interface
export interface ShopifyVariantInput {
    title?: string;
    descriptionHtml?: string | null;
    optionValues: Array<{
        optionName: string;
        name: string;
    }>;
    price: string;
    sku: string;
    inventoryItem: ShopifyInventoryItem;
    inventoryQuantities: ShopifyInventoryQuantity[];
    taxable?: boolean;
    barcode?: string;
    file?: ShopifyProductFile;
}

export interface ShopifyProductSetInput {
    title: string;
    descriptionHtml?: string;
    vendor?: string;
    productType?: string;
    status?: 'ACTIVE' | 'DRAFT' | 'ARCHIVED';
    tags?: string[];
    productOptions?: ShopifyProductOption[];
    files?: ShopifyProductFile[]; // This is for productCreate, not ideal for updates or appending.
    variants: ShopifyVariantInput[];
}

// Query to fetch a page of products and the first page of their variants for a given location
const GET_PRODUCTS_AND_FIRST_VARIANTS_QUERY = `
  query GetProductsByLocation(
    $locationId: ID!,      # Contextual location, though products list is global
    $productsAfter: String, # For product pagination
    $variantsAfter: String  # For the first page of variants within those products
  ) {
    location(id: $locationId) { # Included for context, Shopify product queries are often global
      id
      name
    }
    products(first: 20, after: $productsAfter) { # Paginate products (e.g., 20 per page)
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        cursor # Product cursor
        node { # ShopifyProductNode
          id
          title
          status
          descriptionHtml
          tags
          media(first: 5) { # First 5 media items
            edges {
              node {
                id
                preview {
                  image {
                    url
                  }
                }
              }
            }
            # Not paginating media further in this example, but could be added
          }
          variants(first: 30, after: $variantsAfter) { # First page of variants (e.g., 30 per page)
            pageInfo {
              hasNextPage
              endCursor
            }
            edges {
              cursor # Variant cursor
              node { # ShopifyVariantNode
                id
                sku
                barcode
                compareAtPrice
                createdAt
                price
                taxable
                taxCode
                inventoryQuantity
                inventoryItem {
                  sku # inventoryItem.sku
                  measurement {
                    weight {
                      unit
                      value
                    }
                  }
                  inventoryLevels(first: 10) { # First 10 inventory levels for this variant
                    edges {
                      node { # ShopifyInventoryLevelNode
                        location {
                          id
                          name
                          isActive
                        }
                      }
                    }
                    # Not paginating inventory levels further here
                  }
                }
                # Add selectedOptions and weight/weightUnit if they become available at variantNode level directly from GQL
                # For now, mapper might derive them or they are part of inventoryItem
              }
            }
          }
          totalInventory
          tracksInventory
          updatedAt
          variantsCount {
            count
          }
        }
      }
    }
  }
`;

// Query to fetch subsequent pages of variants for a specific product ID
const GET_PRODUCT_VARIANTS_QUERY = `
  query GetProductVariants($productId: ID!, $variantsAfter: String) {
    node(id: $productId) {
      ... on Product {
        variants(first: 50, after: $variantsAfter) { # Fetch up to 50 variants per page for a specific product
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            cursor
            node { # ShopifyVariantNode structure (must match fields used by mapper)
              id
              sku
              barcode
              compareAtPrice
              createdAt
              price
              taxable
              taxCode
              inventoryQuantity
              inventoryItem {
                sku
                measurement {
                  weight {
                    unit
                    value
                  }
                }
                inventoryLevels(first: 10) {
                  edges {
                    node {
                      location {
                        id
                        name
                        isActive
                      }
                    }
                  }
                }
              }
              # selectedOptions # if available directly
              # weight # if available directly
              # weightUnit # if available directly
            }
          }
        }
      }
    }
  }
`;

// Query to create a product in Shopify
const CREATE_PRODUCT_MUTATION = `
  mutation CreateProduct($input: ProductInput!) {
    productCreate(input: $input) {
      product {
        id
        title
        status
        variants(first: 1) {
          edges {
            node {
              id
              sku
            }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// Query to update a product in Shopify
const UPDATE_PRODUCT_MUTATION = `
  mutation UpdateProduct($input: ProductInput!) {
    productUpdate(input: $input) {
      product {
        id
        title
        status
        variants(first: 1) {
          edges {
            node {
              id
              sku
            }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// Query to update inventory levels
const UPDATE_INVENTORY_LEVELS_MUTATION = `
  mutation UpdateInventoryLevels($inventoryItemId: ID!, $locationId: ID!, $availableDelta: Int!) {
    inventoryAdjustQuantity(
      input: {
        inventoryItemId: $inventoryItemId
        locationId: $locationId
        availableDelta: $availableDelta
      }
    ) {
      inventoryLevel {
        location {
          id
          name
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// Add new query for fetching inventory levels
const GET_INVENTORY_LEVELS_QUERY = `
  query GetInventoryLevelsForVariants($variantIds: [ID!]!) {
    nodes(ids: $variantIds) {
      ... on ProductVariant {
        id
        inventoryItem {
          inventoryLevels(first: 10) {
            edges {
              node {
                location {
                  id
                }
              }
            }
          }
        }
      }
    }
  }
`;

// +++ Add new query for fetching product overviews +++
const GET_ALL_PRODUCT_OVERVIEWS_QUERY = `
  query GetAllProductOverviews($cursor: String) {
    products(first: 100, after: $cursor, sortKey: UPDATED_AT) { # Fetch 100, sort by UPDATED_AT
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          title
          updatedAt
          variants(first: 1) { # Only need the first variant for its SKU
            edges {
              node {
                sku
              }
            }
          }
        }
      }
    }
  }
`;

// +++ Add new query for fetching products by their IDs +++
const GET_PRODUCTS_BY_IDS_QUERY = `
  query GetProductsByIds($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        status
        descriptionHtml
        tags
        media(first: 10) {
          edges {
            node {
              id
              preview {
                image {
                  url
                }
              }
            }
          }
        }
        variants(first: 50) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              sku
              barcode
              compareAtPrice
              createdAt
              price
              taxable
              taxCode
              inventoryQuantity
              inventoryItem {
                sku
                measurement {
                  weight {
                    unit
                    value
                  }
                }
                inventoryLevels(first: 10) {
                  edges {
                    node {
                      location {
                        isActive
                      }
                      quantities(names: "available") {
                        quantity
                        name
                        id
                      }
                    }
                  }
                }
              }
            }
          }
        }
        totalInventory
        tracksInventory
        updatedAt
        variantsCount {
          count
        }
      }
    }
  }
`;

const GET_ALL_LOCATIONS_QUERY = `
  query GetAllLocations {
    locations(first: 50) {
      edges {
        node {
          id
          name
          address {
            formatted
          }
          isActive
          createdAt
        }
      }
    }
  }
`;

const CREATE_PRODUCT_ASYNC_MUTATION = `
  mutation CreateProductAsyncWithMedia($productInput: ProductSetInput!) {
    productSet(input: $productInput, synchronous: false) {
      product {
        id
        title
      }
      productSetOperation {
        id
        status
        product {
          id
          title
          status
          options {
            name
            values
          }
          media(first: 10) {
            nodes {
              id
              alt
              mediaContentType
              status
              preview {
                image {
                  url
                }
              }
            }
          }
          variants {
            nodes {
              id
              title
              price
              sku
              media(first: 1) {
                nodes {
                  id
                  alt
                  mediaContentType
                  status
                  preview {
                    image {
                      url
                    }
                  }
                }
              }
            }
          }
        }
        userErrors {
          field
          message
          code
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

// New interface for productAppendMedia
export interface ShopifyMediaInput {
    originalSource: string;
    alt?: string;
    mediaContentType: 'IMAGE' | 'VIDEO' | 'EXTERNAL_VIDEO' | 'MODEL_3D';
}

@Injectable()
export class ShopifyApiClient {
    private readonly logger = new Logger(ShopifyApiClient.name);
    private readonly shopify: Shopify;
    private readonly connectionsService: PlatformConnectionsService;

    constructor(
        private configService: ConfigService,
        connectionsService: PlatformConnectionsService
    ) {
        this.connectionsService = connectionsService;
        const apiKey = this.configService.get<string>('SHOPIFY_API_KEY');
        const apiSecret = this.configService.get<string>('SHOPIFY_API_SECRET');
        const scopes = this.configService.get<string>('SHOPIFY_SCOPES')?.split(',');
        const hostName = this.configService.get<string>('HOST_NAME');

        if (!apiKey || !apiSecret || !scopes || !hostName) {
            this.logger.error('Missing Shopify API configuration (Key, Secret, Scopes, HostName)');
            throw new InternalServerErrorException('Shopify API configuration is incomplete.');
        }

        this.shopify = shopifyApi({
            apiKey: apiKey,
            apiSecretKey: apiSecret,
            scopes: scopes,
            hostName: hostName,
            apiVersion: LATEST_API_VERSION,
            isEmbeddedApp: false,
        });
        this.logger.log(`Shopify API Context Initialized. API Version: ${LATEST_API_VERSION}`);
    }

    private async getGraphQLClient(connection: PlatformConnection): Promise<GraphqlClient> {
        const shop = connection.PlatformSpecificData?.['shop'];
        if (!shop) {
             this.logger.error(`Shop domain missing in PlatformSpecificData for connection ${connection.Id}`);
             throw new InternalServerErrorException(`Configuration error for connection ${connection.Id}: Missing shop domain.`);
        }

        let credentials: ShopifyCredentials;
        try {
            const decrypted = await this.connectionsService.getDecryptedCredentials(connection);
            if (!decrypted?.accessToken) {
                 throw new Error('Decrypted credentials missing accessToken.');
            }
            credentials = decrypted as ShopifyCredentials;
        } catch (error) {
            this.logger.error(`Failed to get/decrypt credentials for connection ${connection.Id}: ${error.message}`);
            throw new UnauthorizedException(`Could not access credentials for connection ${connection.Id}.`);
        }

        const session = new Session({
            id: `offline_${shop}`,
            shop: shop,
            state: 'temp_state',
            isOnline: false,
            accessToken: credentials.accessToken,
        });

        this.logger.debug(`Creating GraphQL client for shop: ${session.shop}`);
        return new this.shopify.clients.Graphql({ session });
    }

    // Helper to fetch all locations with pagination
    private async _fetchLocations(client: GraphqlClient, shop: string): Promise<ShopifyLocationNode[]> {
        const query = `
          query GetLocations($cursor: String) {
            locations(first: 50, after: $cursor) {
              pageInfo {
                hasNextPage
                endCursor
              }
              edges {
                node {
                  id
                  name
                  isActive
                }
              }
            }
          }
        `;

        let allShopifyLocations: ShopifyLocationNode[] = [];
        let hasNextPage = true;
        let cursor: string | null = null;

        this.logger.log(`Starting location fetch loop for shop: ${shop}`);
        while (hasNextPage) {
            this.logger.debug(`Fetching location page with cursor: ${cursor}`);
        try {
                 const response = await client.request<{ locations: { pageInfo: { hasNextPage: boolean; endCursor: string | null }, edges: { node: ShopifyLocationNode }[] } }>(query, {
                    variables: { cursor },
                });

                if (response.errors) {
                     this.logger.error(`GraphQL location query errors for shop ${shop}: ${JSON.stringify(response.errors)}`);
                     throw new InternalServerErrorException(`GraphQL location query failed: ${response.errors[0]?.message}`);
                }

                 const pageData = response.data?.locations;
                if (!pageData) {
                     this.logger.error(`Unexpected GraphQL location response structure for shop ${shop}: ${JSON.stringify(response.data)}`);
                     throw new InternalServerErrorException('Invalid data structure in Shopify location response.');
                }

                 const locationsOnPage: ShopifyLocationNode[] = pageData.edges.map(edge => edge.node);
                 allShopifyLocations.push(...locationsOnPage);

                hasNextPage = pageData.pageInfo.hasNextPage;
                cursor = pageData.pageInfo.endCursor;
                 this.logger.debug(`Fetched ${locationsOnPage.length} locations. hasNextPage: ${hasNextPage}`);
            } catch (error) {
                 this.logger.error(`Error fetching locations page for shop ${shop}: ${error.message}`, error.stack);
                 if (error instanceof UnauthorizedException || (error instanceof Response && (error.status === 401 || error.status === 403))) {
                     throw new UnauthorizedException(`Shopify authentication failed during location fetch for shop ${shop}.`);
                 }
                 throw new InternalServerErrorException(`Failed to fetch locations from Shopify: ${error.message}`);
            }
        }
        this.logger.log(`Finished fetching ${allShopifyLocations.length} locations for shop: ${shop}`);
        return allShopifyLocations;
    }

    // Fetch products, their variants, and locations using the user-specified query structure
    async fetchAllRelevantData(connection: PlatformConnection): Promise<{ products: ShopifyProductNode[], locations: ShopifyLocationNode[] }> {
        const shop = connection.PlatformSpecificData?.['shop'];
        this.logger.log(`Fetching all relevant data from Shopify for shop: ${shop} with new pagination logic...`);
        const client = await this.getGraphQLClient(connection);

        const allShopifyLocations = await this._fetchLocations(client, shop);
        if (!allShopifyLocations || allShopifyLocations.length === 0) {
            this.logger.warn(`No locations found for shop ${shop}. Returning empty product list.`);
            return { products: [], locations: [] };
        }

        const allProductsMap = new Map<string, ShopifyProductNode>();
        
        // Use the first location for the main product fetch context, as products are global but query needs a locationId.
        // Inventory levels within variants will be specific to their own locations.
        const primaryLocationIdForProductQuery = allShopifyLocations[0].id;
        this.logger.log(`Using location ${primaryLocationIdForProductQuery} as context for initial product list fetch.`);

        let productsCursor: string | null = null;
        let hasNextProductPage = true;
        let productPagesFetched = 0;

        while (hasNextProductPage) {
            productPagesFetched++;
            this.logger.log(`Fetching product page ${productPagesFetched} for shop ${shop} (location context: ${primaryLocationIdForProductQuery}), productsAfter: ${productsCursor}`);
            
            try {
                // Type for the response of GET_PRODUCTS_AND_FIRST_VARIANTS_QUERY
                type ProductsAndFirstVariantsResponse = {
                    location: ShopifySpecificLocationInfo; // Contextual
                    products: {
                        pageInfo: { hasNextPage: boolean; endCursor: string | null };
                        edges: { cursor: string; node: ShopifyProductNode }[];
                    };
                };

                const productPageResponse = await client.request<ProductsAndFirstVariantsResponse>(
                    GET_PRODUCTS_AND_FIRST_VARIANTS_QUERY,
                    {
                        variables: {
                            locationId: primaryLocationIdForProductQuery,
                            productsAfter: productsCursor,
                            variantsAfter: null, // Always null here to get the first page of variants for products on this product page
                        },
                    }
                );

                if (productPageResponse.errors) {
                    this.logger.error(`GraphQL product page query errors for shop ${shop}: ${JSON.stringify(productPageResponse.errors)}`);
                    throw new InternalServerErrorException(`GraphQL product page query failed: ${productPageResponse.errors[0]?.message}`);
                }

                const productsData = productPageResponse.data?.products;
                if (!productsData || !productsData.edges) {
                    this.logger.warn(`No products data or edges in response for product page ${productPagesFetched}, shop ${shop}.`);
                    hasNextProductPage = false; // Stop if no data
                    continue;
                }

                for (const productEdge of productsData.edges) {
                    const productNode = productEdge.node;
                    if (!productNode) continue;

                    // --- Fetch all variants for this productNode ---
                    let collectedVariantsForProduct: ShopifyVariantNode[] = productNode.variants.edges.map(e => e.node);
                    let productSpecificVariantsCursor = productNode.variants.pageInfo.endCursor;
                    let hasNextVariantPageForProduct = productNode.variants.pageInfo.hasNextPage;
                    let variantPagesFetchedForProduct = 0;

                    while (hasNextVariantPageForProduct) {
                        variantPagesFetchedForProduct++;
                        this.logger.debug(`Fetching variant page ${variantPagesFetchedForProduct + 1} for product ${productNode.id}, variantsAfter: ${productSpecificVariantsCursor}`);
                        
                        // Type for GET_PRODUCT_VARIANTS_QUERY response
                        type ProductVariantsResponse = {
                            node: { // This 'node' corresponds to the Product
                                variants: {
                                    pageInfo: { hasNextPage: boolean; endCursor: string | null };
                                    edges: { cursor: string; node: ShopifyVariantNode }[];
                                };
                            } | null; // It's nullable if product ID not found
                        };
                        
                        const variantPageResponse = await client.request<ProductVariantsResponse>(
                            GET_PRODUCT_VARIANTS_QUERY,
                            {
                                variables: {
                                    productId: productNode.id,
                                    variantsAfter: productSpecificVariantsCursor,
                                },
                            }
                        );

                        if (variantPageResponse.errors) {
                            this.logger.error(`GraphQL variant page query errors for product ${productNode.id}: ${JSON.stringify(variantPageResponse.errors)}`);
                            // Decide: stop fetching variants for this product or stop all? For now, stop for this product.
                            hasNextVariantPageForProduct = false; 
                            continue;
                        }
                        
                        const newVariantsData = variantPageResponse.data?.node?.variants;
                        if (newVariantsData && newVariantsData.edges.length > 0) {
                            collectedVariantsForProduct.push(...newVariantsData.edges.map(e => e.node));
                        }
                        hasNextVariantPageForProduct = newVariantsData?.pageInfo.hasNextPage || false;
                        productSpecificVariantsCursor = newVariantsData?.pageInfo.endCursor || null;
                    }
                    // --- End fetching all variants for this productNode ---
                    
                    // Replace the initial (partial) variant list with the fully fetched one
                    // We need to reconstruct the 'edges' structure if the mapper expects it,
                    // or adjust the mapper to take a flat list of variants.
                    // For now, let's assume the mapper can be adapted or we store a flat list.
                    // The ShopifyProductNode interface expects 'variants: { edges: { node: ShopifyVariantNode }[] }'
                    // So, we reconstruct it.
                    productNode.variants = {
                        edges: collectedVariantsForProduct.map(variant => ({ node: variant })),
                        // pageInfo is now stale for the productNode's direct variants list, as we've fetched all.
                        // We can set it to reflect completion.
                        pageInfo: { hasNextPage: false, endCursor: productSpecificVariantsCursor } 
                    };
                    
                    allProductsMap.set(productNode.id, productNode);
                } // End loop over products on the current product page

                hasNextProductPage = productsData.pageInfo.hasNextPage;
                productsCursor = productsData.pageInfo.endCursor;
                this.logger.debug(`Processed ${productsData.edges.length} products from page ${productPagesFetched}. More products: ${hasNextProductPage}. Next cursor: ${productsCursor}`);

            } catch (error) {
                this.logger.error(`Failed to fetch or process product page ${productPagesFetched} from Shopify for shop ${shop}: ${error.message}`, error.stack);
                 if (error instanceof UnauthorizedException || (error.message?.includes('401') || error.message?.includes('403'))) {
                      await this.connectionsService.updateConnectionStatus(connection.Id, connection.UserId, 'error').catch(e => this.logger.error(`Failed update status: ${e.message}`));
                      throw new UnauthorizedException(`Shopify authentication failed during product fetch for shop ${shop}.`);
                 }
                // If one page fails, we might want to stop all, or try to continue.
                // For now, stop all by rethrowing.
                throw error; 
            }
        } // End while (hasNextProductPage)

        const uniqueProducts = Array.from(allProductsMap.values());
        this.logger.log(`Finished fetching data. Total unique products: ${uniqueProducts.length}. Total product pages fetched: ${productPagesFetched}. Total locations: ${allShopifyLocations.length}`);
        return { products: uniqueProducts, locations: allShopifyLocations };
    }

    async fetchAllProductOverviews(connection: PlatformConnection): Promise<ShopifyProductOverview[]> {
        const shop = connection.PlatformSpecificData?.['shop'];
        this.logger.log(`Fetching all product overviews from Shopify for shop: ${shop}...`);
        const client = await this.getGraphQLClient(connection);

        let allOverviews: ShopifyProductOverview[] = [];
        let cursor: string | null = null;
        let hasNextPage = true;
        let pagesFetched = 0;

        while (hasNextPage) {
            pagesFetched++;
            this.logger.debug(`Fetching product overview page ${pagesFetched} for shop ${shop}, after: ${cursor}`);

            try {
                const response = await client.request<{
                    products: {
                        pageInfo: { hasNextPage: boolean; endCursor: string | null };
                        edges: { node: { id: string; title: string; updatedAt: string; variants: { edges: { node: { sku: string | null } }[] } } }[];
                    };
                }>(GET_ALL_PRODUCT_OVERVIEWS_QUERY, {
                    variables: { cursor },
                });

                if (response.errors) {
                    this.logger.error(`GraphQL product overviews query errors for shop ${shop}: ${JSON.stringify(response.errors)}`);
                    throw new InternalServerErrorException(`GraphQL product overviews query failed: ${response.errors[0]?.message}`);
                }

                const productsData = response.data?.products;
                if (!productsData || !productsData.edges) {
                    this.logger.warn(`No products data or edges in response for overview page ${pagesFetched}, shop ${shop}.`);
                    hasNextPage = false;
                    continue;
                }

                for (const edge of productsData.edges) {
                    const productNode = edge.node;
                    allOverviews.push({
                        id: productNode.id,
                        title: productNode.title,
                        sku: productNode.variants?.edges[0]?.node?.sku || null,
                        updatedAt: productNode.updatedAt,
                    });
                }

                hasNextPage = productsData.pageInfo.hasNextPage;
                cursor = productsData.pageInfo.endCursor;
                this.logger.debug(`Processed ${productsData.edges.length} product overviews from page ${pagesFetched}. More: ${hasNextPage}.`);

            } catch (error) {
                this.logger.error(`Failed to fetch product overview page ${pagesFetched} from Shopify for shop ${shop}: ${error.message}`, error.stack);
                if (error instanceof UnauthorizedException || (error.message?.includes('401') || error.message?.includes('403'))) {
                    await this.connectionsService.updateConnectionStatus(connection.Id, connection.UserId, 'error').catch(e => this.logger.error(`Failed update status: ${e.message}`));
                    throw new UnauthorizedException(`Shopify authentication failed during product overview fetch for shop ${shop}.`);
                }
                throw error;
            }
        }
        this.logger.log(`Finished fetching product overviews. Total: ${allOverviews.length} for shop: ${shop}.`);
        return allOverviews;
    }

    async createProduct(
        connection: PlatformConnection,
        productData: {
            title: string;
            description?: string;
            status?: 'ACTIVE' | 'DRAFT' | 'ARCHIVED';
            vendor?: string;
            productType?: string;
            variants: Array<{
                sku: string;
                price: number;
                compareAtPrice?: number;
                inventoryQuantity?: number;
                weight?: number;
                weightUnit?: 'KILOGRAMS' | 'GRAMS' | 'POUNDS' | 'OUNCES';
                options?: Array<{ name: string; value: string }>;
            }>;
            images?: Array<{ url: string; altText?: string }>;
        }
    ): Promise<{ productId: string; variantId: string }> {
        const client = await this.getGraphQLClient(connection);
        this.logger.log(`Creating product in Shopify for connection ${connection.Id}`);

        try {
            const response = await client.request(CREATE_PRODUCT_MUTATION, {
                variables: {
                    input: {
                        title: productData.title,
                        descriptionHtml: productData.description,
                        status: productData.status || 'DRAFT',
                        vendor: productData.vendor,
                        productType: productData.productType,
                        variants: productData.variants.map(variant => ({
                            sku: variant.sku,
                            price: variant.price.toString(),
                            compareAtPrice: variant.compareAtPrice?.toString(),
                            inventoryQuantities: variant.inventoryQuantity ? [{
                                available: variant.inventoryQuantity,
                                locationId: 'gid://shopify/Location/1' // Default location, should be configurable
                            }] : undefined,
                            weight: variant.weight,
                            weightUnit: variant.weightUnit,
                            options: variant.options
                        })),
                        images: productData.images?.map(image => ({
                            src: image.url,
                            altText: image.altText
                        }))
                    }
                }
            });

            if (response.errors) {
                this.logger.error(`GraphQL product creation errors: ${JSON.stringify(response.errors)}`);
                throw new InternalServerErrorException(`Failed to create product: ${response.errors[0]?.message}`);
            }

            const product = response.data?.productCreate?.product;
            if (!product) {
                throw new InternalServerErrorException('Failed to create product: No product data returned');
            }

            const variant = product.variants.edges[0]?.node;
            if (!variant) {
                throw new InternalServerErrorException('Failed to create product: No variant data returned');
            }

            return {
                productId: product.id,
                variantId: variant.id
            };
        } catch (error) {
            this.logger.error(`Error creating product: ${error.message}`, error.stack);
            throw error instanceof HttpException ? error : new InternalServerErrorException('Failed to create product');
        }
    }

    async updateProduct(
        connection: PlatformConnection,
        productId: string,
        productData: {
            title?: string;
            description?: string;
            status?: 'ACTIVE' | 'DRAFT' | 'ARCHIVED';
            vendor?: string;
            productType?: string;
            variants?: Array<{
                id: string;
                sku?: string;
                price?: number;
                compareAtPrice?: number;
                inventoryQuantity?: number;
                weight?: number;
                weightUnit?: 'KILOGRAMS' | 'GRAMS' | 'POUNDS' | 'OUNCES';
                options?: Array<{ name: string; value: string }>;
            }>;
            images?: Array<{ url: string; altText?: string }>;
        }
    ): Promise<{ productId: string; variantId: string }> {
        const client = await this.getGraphQLClient(connection);
        this.logger.log(`Updating product ${productId} in Shopify for connection ${connection.Id}`);

        try {
            const response = await client.request(UPDATE_PRODUCT_MUTATION, {
                variables: {
                    input: {
                        id: productId,
                        title: productData.title,
                        descriptionHtml: productData.description,
                        status: productData.status,
                        vendor: productData.vendor,
                        productType: productData.productType,
                        variants: productData.variants?.map(variant => ({
                            id: variant.id,
                            sku: variant.sku,
                            price: variant.price?.toString(),
                            compareAtPrice: variant.compareAtPrice?.toString(),
                            inventoryQuantities: variant.inventoryQuantity ? [{
                                available: variant.inventoryQuantity,
                                locationId: 'gid://shopify/Location/1' // Default location, should be configurable
                            }] : undefined,
                            weight: variant.weight,
                            weightUnit: variant.weightUnit,
                            options: variant.options
                        })),
                        images: productData.images?.map(image => ({
                            src: image.url,
                            altText: image.altText
                        }))
                    }
                }
            });

            if (response.errors) {
                this.logger.error(`GraphQL product update errors: ${JSON.stringify(response.errors)}`);
                throw new InternalServerErrorException(`Failed to update product: ${response.errors[0]?.message}`);
            }

            const product = response.data?.productUpdate?.product;
            if (!product) {
                throw new InternalServerErrorException('Failed to update product: No product data returned');
            }

            const variant = product.variants.edges[0]?.node;
            if (!variant) {
                throw new InternalServerErrorException('Failed to update product: No variant data returned');
            }

            return {
                productId: product.id,
                variantId: variant.id
            };
        } catch (error) {
            this.logger.error(`Error updating product: ${error.message}`, error.stack);
            throw error instanceof HttpException ? error : new InternalServerErrorException('Failed to update product');
        }
    }

    async updateInventoryLevel(
        connection: PlatformConnection,
        inventoryItemId: string,
        locationId: string,
        quantity: number
    ): Promise<{ available: number; location: { id: string; name: string } }> {
        const client = await this.getGraphQLClient(connection);
        this.logger.log(`Updating inventory level for item ${inventoryItemId} at location ${locationId}`);

        try {
            const response = await client.request(UPDATE_INVENTORY_LEVELS_MUTATION, {
                variables: {
                    inventoryItemId,
                    locationId,
                    available: quantity
                }
            });

            if (response.errors) {
                this.logger.error(`GraphQL inventory update errors: ${JSON.stringify(response.errors)}`);
                throw new InternalServerErrorException(`Failed to update inventory: ${response.errors[0]?.message}`);
            }

            const inventoryLevel = response.data?.inventoryAdjustQuantity?.inventoryLevel;
            if (!inventoryLevel) {
                throw new InternalServerErrorException('Failed to update inventory: No inventory level data returned');
            }

            return inventoryLevel;
        } catch (error) {
            this.logger.error(`Error updating inventory: ${error.message}`, error.stack);
            throw error instanceof HttpException ? error : new InternalServerErrorException('Failed to update inventory');
        }
    }

    async getAllLocations(connection: PlatformConnection): Promise<ShopifyLocation[]> {
        const client = await this.getGraphQLClient(connection);
        this.logger.log(`Fetching all locations for shop: ${connection.PlatformSpecificData?.['shop']}`);

        try {
            const response = await client.request<{
                locations: {
                    edges: Array<{
                        node: ShopifyLocation;
                    }>;
                };
            }>(GET_ALL_LOCATIONS_QUERY);

            if (response.errors) {
                this.logger.error(`GraphQL location query errors: ${JSON.stringify(response.errors)}`);
                throw new InternalServerErrorException(`Failed to fetch locations: ${response.errors[0]?.message}`);
            }

            if (!response.data?.locations?.edges) {
                throw new InternalServerErrorException('Invalid response structure from Shopify locations query');
            }

            return response.data.locations.edges.map(edge => edge.node);
        } catch (error) {
            this.logger.error(`Error fetching locations: ${error.message}`, error.stack);
            throw error instanceof HttpException ? error : new InternalServerErrorException('Failed to fetch locations');
        }
    }

    async createProductAsync(
        connection: PlatformConnection,
        productInput: ShopifyProductSetInput
    ): Promise<{
        operationId: string;
        status: string;
        productId?: string;
        userErrors: Array<{ field: string[] | null; message: string; code: string }>;
    }> {
        this.logger.log(`[createProductAsync] Attempting to create product on Shopify. Shop: ${connection.DisplayName}`);
        this.logger.debug(`[createProductAsync] Full productInput for Shopify: ${JSON.stringify(productInput, null, 2)}`);

        const client = await this.getGraphQLClient(connection);
        this.logger.log(`Creating product asynchronously in Shopify for connection ${connection.Id}`);

        try {
            type ProductSetResponse = {
                productSet: {
                    product: { id: string; title: string } | null;
                    productSetOperation: ShopifyProductSetOperation;
                    userErrors: Array<{ field: string[] | null; message: string; code: string }>;
                };
            };

            const response = await client.request<ProductSetResponse>(CREATE_PRODUCT_ASYNC_MUTATION, {
                variables: {
                    productInput
                }
            });

            // <<< DETAILED LOGGING OF SHOPIFY'S RESPONSE >>>
            this.logger.debug(`Shopify createProductAsync raw response for connection ${connection.Id}: ${JSON.stringify(response, null, 2)}`);

            // Refined error checking for response.errors
            if (response.errors && Object.keys(response.errors).length > 0 && Array.isArray((response.errors as any).graphQLErrors) && (response.errors as any).graphQLErrors.length > 0) {
                this.logger.error(`GraphQL product creation errors: ${JSON.stringify(response.errors)}`);
                const firstError = (response.errors as any).graphQLErrors[0];
                throw new InternalServerErrorException(`Failed to create product on Shopify: ${firstError.message || 'Unknown GraphQL error'}`);
            } else if (response.errors && !Array.isArray((response.errors as any).graphQLErrors)) {
                 // Handle cases where errors is an object but not structured as expected (e.g. network errors)
                this.logger.error(`GraphQL product creation returned non-array errors object: ${JSON.stringify(response.errors)}`);
                // Attempt to get a general message if possible, otherwise generic error
                const errorMessage = (response.errors as any).message || 'Unknown GraphQL error object';
                throw new InternalServerErrorException(`Failed to create product on Shopify: ${errorMessage}`);
            }

            // Check if response.data or response.data.productSet is null/undefined
            if (!response.data || !response.data.productSet) {
                this.logger.error(`Invalid or missing productSet in Shopify response. Data: ${JSON.stringify(response.data)}`);
                throw new InternalServerErrorException('Invalid response structure from Shopify product creation: productSet missing.');
            }

            const { productSet } = response.data;
            const { productSetOperation, userErrors: topLevelUserErrors } = productSet;

            if (!productSetOperation) {
                this.logger.error(`Shopify productSetOperation is null/undefined. ProductSet: ${JSON.stringify(productSet)}`);
                if (topLevelUserErrors && topLevelUserErrors.length > 0) {
                    this.logger.error(`Top-level user errors from Shopify: ${JSON.stringify(topLevelUserErrors)}`);
                    throw new InternalServerErrorException(`Shopify product creation failed with user errors: ${topLevelUserErrors.map(e => e.message).join(', ')}`);
                }
                throw new InternalServerErrorException('Shopify productSetOperation was not returned, cannot get operation ID.');
            }
            
            const allUserErrors = [...(topLevelUserErrors || []), ...(productSetOperation.userErrors || [])];

            return {
                operationId: productSetOperation.id,
                status: productSetOperation.status,
                productId: productSet.product?.id,
                userErrors: allUserErrors
            };
        } catch (error) {
            this.logger.error(`Error creating product: ${error.message}`, error.stack);
            throw error instanceof HttpException ? error : new InternalServerErrorException('Failed to create product');
        }
    }

    async getInventoryLevels(
        connection: PlatformConnection,
        variantIds: string[]
    ): Promise<Array<{
        variantId: string;
        locationId: string;
        quantity: number;
    }>> {
        if (!variantIds || variantIds.length === 0) {
            return [];
        }

        this.logger.log(`Fetching inventory levels for ${variantIds.length} variants`);

        const idChunks: string[][] = [];
        for (let i = 0; i < variantIds.length; i += 100) {
            idChunks.push(variantIds.slice(i, i + 100));
        }

        const results: Array<{ variantId: string; locationId: string; quantity: number; }> = [];
        const client = await this.getGraphQLClient(connection);

        // Define types for the GraphQL response and variables
        type InventoryLevelsResponse = {
            nodes: Array<{
                id: string;
                inventoryItem?: {
                    inventoryLevels: {
                        edges: Array<{
                            node: {
                                available: number;
                                location: { id: string };
                            };
                        }>;
                    };
                };
            }>;
        };
        type QueryVariables = { variantIds: string[] };

        for (const chunk of idChunks) {
            try {
                const response = await client.request<InventoryLevelsResponse>(GET_INVENTORY_LEVELS_QUERY, {
                    variables: { variantIds: chunk }
                });

                const nodes = response.data?.nodes || [];
                for (const variantNode of nodes) {
                    if (variantNode && variantNode.inventoryItem && variantNode.inventoryItem.inventoryLevels) {
                        for (const levelEdge of variantNode.inventoryItem.inventoryLevels.edges) {
                            results.push({
                                variantId: variantNode.id,
                                locationId: levelEdge.node.location.id,
                                quantity: levelEdge.node.available,
                            });
                        }
                    }
                }
            } catch (error) {
                this.logger.error(`Failed to fetch inventory levels chunk: ${error.message}`, error.stack);
                // Continue to next chunk
            }
        }
        
        this.logger.log(`Successfully fetched ${results.length} inventory level records for ${variantIds.length} variants.`);
        return results;
    }

    // +++ Add new method fetchProductsByIds +++
    async fetchProductsByIds(connection: PlatformConnection, productIds: string[]): Promise<ShopifyProductNode[]> {
        if (!productIds || productIds.length === 0) {
            this.logger.debug('fetchProductsByIds called with no IDs. Returning empty array.');
            return [];
        }
        const shop = connection.PlatformSpecificData?.['shop'];
        this.logger.log(`Fetching ${productIds.length} products by IDs from Shopify for shop: ${shop}...`);
        const client = await this.getGraphQLClient(connection);

        if (productIds.length > 250) {
            this.logger.warn(`fetchProductsByIds called with ${productIds.length} IDs, which exceeds Shopify's typical limit of 250 for the nodes query. Implement batching if this is a common scenario.`);
        }

        try {
            const response = await client.request<{
                nodes: (ShopifyProductNode | null)[] 
            }>(GET_PRODUCTS_BY_IDS_QUERY, {
                variables: { ids: productIds }, 
            });

            if (response.errors) {
                this.logger.error(`GraphQL fetchProductsByIds query errors for shop ${shop}: ${JSON.stringify(response.errors)}`);
                throw new InternalServerErrorException(`GraphQL fetchProductsByIds query failed: ${response.errors[0]?.message}`);
            }

            const fetchedProductsRaw = response.data?.nodes?.filter(node => node !== null) as any[] || [];
            
            const processedProducts: ShopifyProductNode[] = fetchedProductsRaw.map(product => {
                if (product && product.variants && product.variants.edges) {
                    product.variants.edges = product.variants.edges.map((variantEdge: any) => {
                        if (variantEdge.node && variantEdge.node.inventoryItem && variantEdge.node.inventoryItem.inventoryLevels && variantEdge.node.inventoryItem.inventoryLevels.edges) {
                            variantEdge.node.inventoryItem.inventoryLevels.edges = variantEdge.node.inventoryItem.inventoryLevels.edges.map((levelEdge: any) => {
                                if (levelEdge.node) {
                                    levelEdge.node.available = typeof levelEdge.node.available === 'number' ? levelEdge.node.available : 0;
                                }
                                return levelEdge;
                            });
                        }
                        return variantEdge;
                    });
                }
                return product as ShopifyProductNode;
            });

            this.logger.log(`Successfully fetched ${processedProducts.length} products by IDs for shop: ${shop}.`);
            return processedProducts;
        } catch (error) {
            this.logger.error(`Failed to fetch products by IDs from Shopify for shop ${shop}: ${error.message}`, error.stack);
            if (error instanceof UnauthorizedException || (error.message?.includes('401') || error.message?.includes('403'))) {
                await this.connectionsService.updateConnectionStatus(connection.Id, connection.UserId, 'error').catch(e => this.logger.error(`Failed update status: ${e.message}`));
                throw new UnauthorizedException(`Shopify authentication failed during fetchProductsByIds for shop ${shop}.`);
            }
            throw error;
        }
    }

    async updateProductAsync(
        connection: PlatformConnection,
        productId: string, // Shopify Product GID (e.g., "gid://shopify/Product/12345")
        productInput: ShopifyProductSetInput // Re-using this type, as ProductInput for updates is very similar
    ): Promise<{ // Adjusted return type to match ProductUpdateMutationResponse.productUpdate
        product: {
            id: string;
            title: string;
            status: string;
            variants: {
                nodes: Array<{
                    id: string;
                    sku: string | null;
                    title: string;
                    price: string;
                }>;
            } | null;
        } | null;
        userErrors: Array<{ field: string[] | null; message: string; code: string }>;
    }> {
        this.logger.log(`[updateProductAsync] Attempting to update product ${productId} on Shopify. Shop: ${connection.DisplayName}`);
        const client = await this.getGraphQLClient(connection);

        const variables = {
            id: productId,
            input: productInput,
        };

        const mutationString = `
            mutation ProductUpdate($id: ID!, $input: ProductInput!) {
                productUpdate(id: $id, input: $input) {
                    product {
                        id
                        title
                        status
                        variants(first: 100) { 
                            nodes {
                                id
                                sku
                                title
                                price
                            }
                        }
                    }
                    userErrors {
                        field
                        message
                        code
                    }
                }
            }
        `;

        // Define the expected response type directly based on the mutation
        type ProductUpdateMutationResponseData = {
            productUpdate: {
                product: {
                    id: string;
                    title: string;
                    status: string;
                    variants: {
                        nodes: Array<{
                            id: string;
                            sku: string | null;
                            title: string;
                            price: string;
                        }>;
                    } | null;
                } | null;
                userErrors: Array<{ field: string[] | null; message: string; code: string }>;
            };
        };

        try {
            this.logger.debug(`[updateProductAsync] Shopify productUpdate mutation variables for ${productId}: ${JSON.stringify(variables)}`);
            const result = await client.request<ProductUpdateMutationResponseData>(mutationString, { variables });

            this.logger.debug(`[updateProductAsync] Shopify productUpdate mutation raw response for ${productId}: ${JSON.stringify(result)}`);

            if (!result.data || !result.data.productUpdate) { // Check if productUpdate itself is null or undefined, and ensure data exists
                this.logger.error(`[updateProductAsync] Shopify productUpdate mutation for ${productId} returned no data in productUpdate field or data was missing.`);
                throw new InternalServerErrorException(`Shopify productUpdate mutation for ${productId} returned no data or invalid response structure.`);
            }

            // Log user errors if any
            if (result.data.productUpdate.userErrors && result.data.productUpdate.userErrors.length > 0) {
                result.data.productUpdate.userErrors.forEach(err => {
                    this.logger.warn(`[updateProductAsync] UserError for product ${productId}: Fields: ${err.field?.join(', ')}, Message: ${err.message}, Code: ${err.code}`);
                });
                // Potentially throw an error here or let the caller handle userErrors
            }
            
            // Return the productUpdate part of the response directly
            return result.data.productUpdate;

        } catch (error: any) {
            this.logger.error(`[updateProductAsync] Error during Shopify productUpdate mutation for ${productId}: ${error.message}`, error.stack);
            if (error.response?.errors) { // Check for GraphQL specific errors
                error.response.errors.forEach((err: any) => this.logger.error(`GraphQL Error: ${err.message}`));
            }
            // Rethrow as a standard exception type
            throw new HttpException(
                `Shopify product update failed for ${productId}: ${error.message}`, 
                error.response?.status || HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    // New method to append media to a product
    async productAppendMedia(
        connection: PlatformConnection,
        productId: string, // Shopify Product GID
        mediaInputs: ShopifyMediaInput[]
    ): Promise<{
        product: { id: string; media: { nodes: Array<{ id: string; status: string }> } } | null;
        userErrors: Array<{ field: string[] | null; message: string; code: string }>;
    }> {
        this.logger.log(`[productAppendMedia] Attempting to append ${mediaInputs.length} media items to product ${productId} for shop ${connection.PlatformSpecificData?.shop}`);
        const client = await this.getGraphQLClient(connection);
        if (!client) {
            this.logger.error('[productAppendMedia] Failed to get GraphQL client.');
            throw new InternalServerErrorException('Failed to initialize Shopify client for appending media.');
        }

        const mutation = `
            mutation ProductAppendMedia($productId: ID!, $media: [CreateMediaInput!]!) {
                productAppendMedia(productId: $productId, media: $media) {
                    product {
                        id
                        media(first: ${mediaInputs.length * 2}) { # Fetch enough to see new and potentially some existing
                            nodes {
                                id
                                status
                                ... on MediaImage {
                                    preview { image { url } }
                                }
                            }
                        }
                    }
                    userErrors {
                        field
                        message
                        code
                    }
                }
            }
        `;

        try {
            // Adjust the expected response type to be more flexible
            const response = await client.query<any>({
                data: {
                    query: mutation,
                    variables: { productId, media: mediaInputs },
                },
            });

            const productAppendMediaResult = response.body?.data?.productAppendMedia;

            if (productAppendMediaResult?.userErrors?.length) {
                this.logger.warn(`[productAppendMedia] User errors on appending media to product ${productId}: ${JSON.stringify(productAppendMediaResult.userErrors)}`);
            }
            if (!productAppendMediaResult?.product) {
                this.logger.error(`[productAppendMedia] Failed to append media. Product data not returned. Errors: ${JSON.stringify(productAppendMediaResult?.userErrors)}`);
            }

            return productAppendMediaResult || { product: null, userErrors: [{ field: null, message: "Unknown error during productAppendMedia", code: "UNKNOWN" }] };

        } catch (error: any) {
            this.logger.error(`[productAppendMedia] GraphQL error for product ${productId}: ${error.message}`, error.stack);
            const gqlErrors = error.response?.errors;
            if (gqlErrors && Array.isArray(gqlErrors) && gqlErrors.length > 0) {
                 const formattedErrors = gqlErrors.map(e => ({ field: e.extensions?.field || null, message: e.message, code: e.extensions?.code || 'GRAPHQL_ERROR' }));
                 return { product: null, userErrors: formattedErrors };
            }
            throw new InternalServerErrorException(`Failed to append media to product ${productId}: ${error.message}`);
        }
    }

    // TODO: Add methods for updating inventory, creating products etc.
}
