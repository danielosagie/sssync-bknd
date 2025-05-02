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

@Injectable()
export class ShopifyApiClient {
    private readonly logger = new Logger(ShopifyApiClient.name);
    private readonly shopify: Shopify;
    private readonly connectionsService: PlatformConnectionsService; // Inject connection service

    // Store initialized clients per connection instance? Or initialize on demand?
    // For simplicity, let's initialize on demand within methods needing the client.
    // private gqlClient: GraphqlClient | null = null;
    // private restClient: RestClient | null = null;
    // private currentSession: Session | null = null;

    constructor(
        private configService: ConfigService,
        connectionsService: PlatformConnectionsService // Inject here
    ) {
        this.connectionsService = connectionsService; // Assign injected service
        const apiKey = this.configService.get<string>('SHOPIFY_API_KEY');
        const apiSecret = this.configService.get<string>('SHOPIFY_API_SECRET');
        const scopes = this.configService.get<string>('SHOPIFY_SCOPES')?.split(',');
        const hostName = this.configService.get<string>('HOST_NAME'); // e.g., 'your-app-domain.com' needed for context

        if (!apiKey || !apiSecret || !scopes || !hostName) {
            this.logger.error('Missing Shopify API configuration (Key, Secret, Scopes, HostName)');
            throw new InternalServerErrorException('Shopify API configuration is incomplete.');
        }

        this.shopify = shopifyApi({
            apiKey: apiKey,
            apiSecretKey: apiSecret,
            scopes: scopes,
            hostName: hostName,
            apiVersion: LATEST_API_VERSION, // Use the latest or pin a specific version
            isEmbeddedApp: false, // Assuming this is a standalone backend
            // Optional: Add SessionStorage for more complex session handling if needed later
        });
        this.logger.log(`Shopify API Context Initialized. API Version: ${LATEST_API_VERSION}`);
    }

    // Method to get an initialized client (call this from methods needing API access)
    private async getGraphQLClient(connection: PlatformConnection): Promise<GraphqlClient> {
        const shop = connection.PlatformSpecificData?.['shop'];
        if (!shop) {
             this.logger.error(`Shop domain missing in PlatformSpecificData for connection ${connection.Id}`);
             throw new InternalServerErrorException(`Configuration error for connection ${connection.Id}: Missing shop domain.`);
        }

        let credentials: ShopifyCredentials;
        try {
            // Decrypt credentials
            const decrypted = await this.connectionsService.getDecryptedCredentials(connection);
            if (!decrypted?.accessToken) {
                 throw new Error('Decrypted credentials missing accessToken.');
            }
            credentials = decrypted as ShopifyCredentials;
        } catch (error) {
            this.logger.error(`Failed to get/decrypt credentials for connection ${connection.Id}: ${error.message}`);
            throw new UnauthorizedException(`Could not access credentials for connection ${connection.Id}.`);
        }

        // Create a temporary session for the API call
        // The library uses Sessions to hold the shop and access token for clients
        const session = new Session({
            id: `offline_${shop}`, // Construct a unique session ID
            shop: shop,
            state: 'temp_state', // Placeholder state
            isOnline: false, // Use offline token for background processing
            accessToken: credentials.accessToken,
            // scope: this.shopify.config.scopes.toString(), // Set scope if needed for session validation (optional here)
        });

        this.logger.debug(`Creating GraphQL client for shop: ${session.shop}`);
        return new this.shopify.clients.Graphql({ session });
    }


    // Initialize is less critical now as clients are created on demand
    // Keep it for logging or potential pre-checks if needed
    async initialize(connection: PlatformConnection): Promise<void> {
        const shop = connection.PlatformSpecificData?.['shop'];
        this.logger.log(`Initializing Shopify API client for shop: ${shop}`);
        // Potential checks: Try getting credentials to ensure they are valid?
        try {
            await this.connectionsService.getDecryptedCredentials(connection);
            this.logger.log(`Credentials accessible for shop: ${shop}`);
        } catch (error) {
             this.logger.warn(`Failed initial credential check for shop ${shop}: ${error.message}`);
             // Decide if this should throw or just log
        }
    }

    // Fetch products and their variants using GraphQL
    async fetchAllRelevantData(connection: PlatformConnection): Promise<{ products: any[], variants: any[], locations: any[] }> {
        const shop = connection.PlatformSpecificData?.['shop'];
        this.logger.log(`Fetching all relevant data from Shopify for shop: ${shop}...`);
        const client = await this.getGraphQLClient(connection);

        // Define the GraphQL query for products, variants, and inventory levels
        // Adjust fields based on what ShopifyMapper needs
        // --- Define an interface for the expected Product Node structure ---
        interface ShopifyProductNode {
            id: string;
            handle: string;
            title: string;
            descriptionHtml: string;
            status: string;
            vendor: string;
            productType: string;
            tags: string[];
            options: { name: string; values: string[] }[];
            variants: {
                edges: {
                    node: {
                        id: string;
                        sku: string;
                        barcode: string;
                        title: string;
                        price: string; // Price comes as string
                        compareAtPrice: string | null;
                        weight: number | null;
                        weightUnit: string;
                        inventoryQuantity: number;
                        inventoryItem: { id: string };
                        image: { id: string; url: string; altText: string } | null;
                        selectedOptions: { name: string; value: string }[];
                    };
                }[];
            };
            images: {
                edges: {
                    node: {
                        id: string;
                        url: string;
                        altText: string;
                    };
                }[];
            };
        }
        // --- End interface definition ---

        const query = `
          query fetchProducts($cursor: String) {
            products(first: 50, after: $cursor) {
              pageInfo {
                hasNextPage
                endCursor
              }
              edges {
                node {
                  id
                  handle
                  title
                  descriptionHtml
                  status
                  vendor
                  productType
                  tags
                  options {
                     name
                     values
                  }
                  variants(first: 100) { # Adjust if more variants per product expected
                    edges {
                      node {
                        id
                        sku
                        barcode
                        title
                        price
                        compareAtPrice
                        weight
                        weightUnit
                        inventoryQuantity
                        inventoryItem {
                           id
                           # Add tracked status etc. if needed
                        }
                        # Add image connection if needed
                        image {
                            id
                            url
                            altText
                        }
                        selectedOptions {
                             name
                             value
                        }
                      }
                    }
                  }
                  # Add images at product level if needed
                  images(first: 10) {
                     edges {
                        node {
                           id
                           url
                           altText
                        }
                     }
                  }
                }
              }
            }
          }
        `;
        // TODO: Add query for Locations (if needed by mapper/sync logic)
        // const locationsQuery = ` ... `;

        let allProducts: ShopifyProductNode[] = []; // <<< Use the interface type
        let hasNextPage = true;
        let cursor = null;

        try {
            this.logger.log(`Starting product fetch loop for shop: ${shop}`);
            while (hasNextPage) {
                this.logger.debug(`Fetching product page with cursor: ${cursor}`);
                const response: any = await client.query({
                    data: { query, variables: { cursor } },
                });

                if (response.body.errors) {
                     this.logger.error(`GraphQL query errors for shop ${shop}: ${JSON.stringify(response.body.errors)}`);
                     throw new InternalServerErrorException(`GraphQL query failed: ${response.body.errors[0]?.message}`);
                }

                const pageData = response.body?.data?.products;
                if (!pageData) {
                    this.logger.error(`Unexpected GraphQL response structure for shop ${shop}: ${JSON.stringify(response.body)}`);
                    throw new InternalServerErrorException('Invalid data structure in Shopify product response.');
                }

                const productsOnPage: ShopifyProductNode[] = pageData.edges.map(edge => edge.node); // <<< Use the interface type
                allProducts.push(...productsOnPage);

                hasNextPage = pageData.pageInfo.hasNextPage;
                cursor = pageData.pageInfo.endCursor;
                this.logger.debug(`Fetched ${productsOnPage.length} products. hasNextPage: ${hasNextPage}`);
                // Optional: Add delay here if hitting rate limits
                // await new Promise(resolve => setTimeout(resolve, 500));
            }
            this.logger.log(`Finished fetching ${allProducts.length} products for shop: ${shop}`);

            // TODO: Fetch locations separately if needed
            const allLocations = []; // Placeholder

            // Flatten variants (or let mapper handle it) - depends on canonical structure
            // <<< Add type annotation to p >>>
            const allVariants = allProducts.flatMap((p: ShopifyProductNode) => p.variants?.edges?.map(e => ({ ...e.node, productId: p.id })) || []);
            this.logger.log(`Extracted ${allVariants.length} variants for shop: ${shop}`);

            return { products: allProducts, variants: allVariants, locations: allLocations };

        } catch (error) {
            this.logger.error(`Failed to fetch data from Shopify for shop ${shop}: ${error.message}`, error.stack);
            // Catch specific API errors if possible (e.g., rate limits, auth errors)
             if (error instanceof Response && error.status === 429) {
                  this.logger.warn(`Shopify rate limit hit for shop ${shop}.`);
             } else if (error instanceof Response && (error.status === 401 || error.status === 403)) {
                  this.logger.error(`Shopify authentication/authorization error for shop ${shop}. Check token/scopes.`);
                  // Optionally update connection status to 'error' or 'needs_reauth'
                  await this.connectionsService.updateConnectionStatus(connection.Id, connection.UserId, 'error').catch(e => this.logger.error(`Failed update status: ${e.message}`));
                  throw new UnauthorizedException(`Shopify authentication failed for shop ${shop}.`);
             }
            throw new InternalServerErrorException(`Failed to fetch data from Shopify: ${error.message}`);
        }
    }

    // TODO: Add methods for updating inventory, creating products etc. using GraphQL mutations or REST client
}
