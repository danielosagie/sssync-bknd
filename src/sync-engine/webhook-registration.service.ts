import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ShopifyApiClient } from '../platform-adapters/shopify/shopify-api-client.service';
import { PlatformConnection } from '../platform-connections/platform-connections.service';

export interface WebhookRegistrationResult {
  success: boolean;
  webhooks: Array<{
    topic: string;
    id?: string;
    endpoint: string;
    error?: string;
  }>;
}

@Injectable()
export class WebhookRegistrationService {
  private readonly logger = new Logger(WebhookRegistrationService.name);

  // Webhook topics that are essential for real-time sync
  private readonly REQUIRED_WEBHOOK_TOPICS = [
    'products/create',
    'products/update', 
    'products/delete',
    'inventory_levels/update',
    // You can add more topics as needed:
    // 'orders/create',
    // 'orders/updated', 
    // 'orders/cancelled',
  ];

  constructor(
    private readonly configService: ConfigService,
  ) {}

  /**
   * Register all required webhooks for a Shopify connection
   */
  async registerShopifyWebhooks(
    connection: PlatformConnection,
    shopifyApiClient: ShopifyApiClient
  ): Promise<WebhookRegistrationResult> {
    const baseUrl = this.configService.get<string>('BASE_URL') || 'https://your-domain.com';
    const result: WebhookRegistrationResult = {
      success: true,
      webhooks: [],
    };

    this.logger.log(`Registering webhooks for Shopify connection ${connection.Id} (User: ${connection.UserId})`);

    for (const topic of this.REQUIRED_WEBHOOK_TOPICS) {
      try {
        const webhookEndpoint = `${baseUrl}/webhook/shopify/${connection.Id}`;
        
        // Check if webhook already exists
        const existingWebhooks = await this.getExistingWebhooks(shopifyApiClient, connection, topic);
        
        let webhookId: string | undefined;
        
        if (existingWebhooks.length > 0) {
          // Update existing webhook if endpoint is different
          const existingWebhook = existingWebhooks[0];
          if (existingWebhook.address !== webhookEndpoint) {
            this.logger.log(`Updating existing webhook for topic ${topic}`);
            webhookId = await this.updateWebhook(shopifyApiClient, connection, existingWebhook.id, topic, webhookEndpoint);
          } else {
            webhookId = existingWebhook.id;
            this.logger.log(`Webhook for topic ${topic} already exists with correct endpoint`);
          }
        } else {
          // Create new webhook
          this.logger.log(`Creating new webhook for topic ${topic}`);
          webhookId = await this.createWebhook(shopifyApiClient, connection, topic, webhookEndpoint);
        }

        result.webhooks.push({
          topic,
          id: webhookId,
          endpoint: webhookEndpoint,
        });

      } catch (error) {
        this.logger.error(`Failed to register webhook for topic ${topic}: ${error.message}`, error.stack);
        result.success = false;
        result.webhooks.push({
          topic,
          endpoint: `${baseUrl}/webhook/shopify/${connection.Id}`,
          error: error.message,
        });
      }
    }

    if (result.success) {
      this.logger.log(`Successfully registered ${result.webhooks.length} webhooks for connection ${connection.Id}`);
    } else {
      this.logger.warn(`Webhook registration completed with errors for connection ${connection.Id}`);
    }

    return result;
  }

  /**
   * Unregister all webhooks for a connection (when connection is deleted)
   */
  async unregisterShopifyWebhooks(
    connection: PlatformConnection,
    shopifyApiClient: ShopifyApiClient
  ): Promise<boolean> {
    this.logger.log(`Unregistering webhooks for Shopify connection ${connection.Id}`);

    try {
      const baseUrl = this.configService.get<string>('BASE_URL') || 'https://your-domain.com';
      const webhookEndpoint = `${baseUrl}/webhook/shopify/${connection.Id}`;

      // Get all webhooks pointing to our endpoint
      const allWebhooks = await this.getAllWebhooks(shopifyApiClient, connection);
      const ourWebhooks = allWebhooks.filter(webhook => 
        webhook.address === webhookEndpoint
      );

      for (const webhook of ourWebhooks) {
        await this.deleteWebhook(shopifyApiClient, connection, webhook.id);
        this.logger.log(`Deleted webhook ${webhook.id} for topic ${webhook.topic}`);
      }

      this.logger.log(`Successfully unregistered ${ourWebhooks.length} webhooks for connection ${connection.Id}`);
      return true;

    } catch (error) {
      this.logger.error(`Failed to unregister webhooks for connection ${connection.Id}: ${error.message}`, error.stack);
      return false;
    }
  }

  private async getExistingWebhooks(shopifyApiClient: ShopifyApiClient, connection: PlatformConnection, topic: string): Promise<any[]> {
    const query = `
      query getWebhooks($topic: WebhookSubscriptionTopic!) {
        webhookSubscriptions(first: 10, topics: [$topic]) {
          edges {
            node {
              id
              callbackUrl
              topic
            }
          }
        }
      }
    `;

    try {
      const response = await shopifyApiClient.requestWithConnection(connection, query, { topic: topic.toUpperCase().replace('/', '_') });
      return response.webhookSubscriptions.edges.map((edge: any) => ({
        id: edge.node.id,
        address: edge.node.callbackUrl,
        topic: edge.node.topic,
      }));
    } catch (error) {
      this.logger.error(`Error fetching existing webhooks for topic ${topic}: ${error.message}`);
      return [];
    }
  }

  private async getAllWebhooks(shopifyApiClient: ShopifyApiClient, connection: PlatformConnection): Promise<any[]> {
    const query = `
      query getAllWebhooks {
        webhookSubscriptions(first: 50) {
          edges {
            node {
              id
              callbackUrl
              topic
            }
          }
        }
      }
    `;

    try {
      const response = await shopifyApiClient.requestWithConnection(connection, query);
      return response.webhookSubscriptions.edges.map((edge: any) => ({
        id: edge.node.id,
        address: edge.node.callbackUrl,
        topic: edge.node.topic,
      }));
    } catch (error) {
      this.logger.error(`Error fetching all webhooks: ${error.message}`);
      return [];
    }
  }

  private async createWebhook(shopifyApiClient: ShopifyApiClient, connection: PlatformConnection, topic: string, endpoint: string): Promise<string> {
    const mutation = `
      mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
          webhookSubscription {
            id
            callbackUrl
            topic
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const variables = {
      topic: topic.toUpperCase().replace('/', '_'),
      webhookSubscription: {
        callbackUrl: endpoint,
        format: 'JSON',
      },
    };

    const response = await shopifyApiClient.requestWithConnection(connection, mutation, variables);
    
    if (response.webhookSubscriptionCreate.userErrors.length > 0) {
      throw new Error(`Shopify API error: ${response.webhookSubscriptionCreate.userErrors[0].message}`);
    }

    return response.webhookSubscriptionCreate.webhookSubscription.id;
  }

  private async updateWebhook(shopifyApiClient: ShopifyApiClient, connection: PlatformConnection, webhookId: string, topic: string, endpoint: string): Promise<string> {
    const mutation = `
      mutation webhookSubscriptionUpdate($id: ID!, $webhookSubscription: WebhookSubscriptionInput!) {
        webhookSubscriptionUpdate(id: $id, webhookSubscription: $webhookSubscription) {
          webhookSubscription {
            id
            callbackUrl
            topic
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const variables = {
      id: webhookId,
      webhookSubscription: {
        callbackUrl: endpoint,
        format: 'JSON',
      },
    };

    const response = await shopifyApiClient.requestWithConnection(connection, mutation, variables);
    
    if (response.webhookSubscriptionUpdate.userErrors.length > 0) {
      throw new Error(`Shopify API error: ${response.webhookSubscriptionUpdate.userErrors[0].message}`);
    }

    return response.webhookSubscriptionUpdate.webhookSubscription.id;
  }

  private async deleteWebhook(shopifyApiClient: ShopifyApiClient, connection: PlatformConnection, webhookId: string): Promise<void> {
    const mutation = `
      mutation webhookSubscriptionDelete($id: ID!) {
        webhookSubscriptionDelete(id: $id) {
          deletedWebhookSubscriptionId
          userErrors {
            field
            message
          }
        }
      }
    `;

    const response = await shopifyApiClient.requestWithConnection(connection, mutation, { id: webhookId });
    
    if (response.webhookSubscriptionDelete.userErrors.length > 0) {
      throw new Error(`Shopify API error: ${response.webhookSubscriptionDelete.userErrors[0].message}`);
    }
  }
} 