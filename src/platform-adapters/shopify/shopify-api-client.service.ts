import { Injectable, Logger, InternalServerErrorException, UnauthorizedException } from '@nestjs/common';
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
    // available: number; // This was missing in user's query but is crucial - will add to query
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

    // TODO: Add methods for updating inventory, creating products etc.
}
