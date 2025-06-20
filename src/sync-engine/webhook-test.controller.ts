import {
  Controller,
  Post,
  Body,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
} from '@nestjs/common';

/**
 * Test controller to help debug webhook reception and processing
 * This should only be enabled in development/testing environments
 */
@Controller('test/webhook')
export class WebhookTestController {
  private readonly logger = new Logger(WebhookTestController.name);

  /**
   * Echo webhook endpoint to test webhook reception
   */
  @Post('echo')
  @HttpCode(HttpStatus.OK)
  async echoWebhook(
    @Body() payload: any,
    @Headers() headers: Record<string, string>,
  ): Promise<{
    success: boolean;
    receivedAt: string;
    payload: any;
    headers: Record<string, string>;
  }> {
    this.logger.log('Received test webhook');
    this.logger.debug(`Headers: ${JSON.stringify(headers)}`);
    this.logger.debug(`Payload: ${JSON.stringify(payload)}`);

    return {
      success: true,
      receivedAt: new Date().toISOString(),
      payload,
      headers,
    };
  }

  /**
   * Shopify webhook test endpoint
   */
  @Post('shopify/:connectionId')
  @HttpCode(HttpStatus.OK)
  async testShopifyWebhook(
    @Param('connectionId') connectionId: string,
    @Body() payload: any,
    @Headers() headers: Record<string, string>,
  ): Promise<{ success: boolean; message: string }> {
    const shopifyTopic = headers['x-shopify-topic'];
    const shopDomain = headers['x-shopify-shop-domain'];
    
    this.logger.log(`TEST: Received Shopify webhook for connection ${connectionId}`);
    this.logger.log(`TEST: Topic: ${shopifyTopic}, Shop: ${shopDomain}`);
    this.logger.debug(`TEST: Payload: ${JSON.stringify(payload).substring(0, 500)}...`);

    // Log all relevant headers
    const relevantHeaders = [
      'x-shopify-topic',
      'x-shopify-shop-domain',
      'x-shopify-hmac-sha256',
      'x-shopify-webhook-id',
      'x-shopify-api-version',
    ];

    relevantHeaders.forEach(headerName => {
      if (headers[headerName]) {
        this.logger.log(`TEST: ${headerName}: ${headers[headerName]}`);
      }
    });

    return {
      success: true,
      message: `Test webhook received for ${shopifyTopic} from ${shopDomain}`,
    };
  }

  /**
   * Generate test webhook payload
   */
  @Post('generate/:platform/:topic')
  async generateTestPayload(
    @Param('platform') platform: string,
    @Param('topic') topic: string,
  ): Promise<{
    platform: string;
    topic: string;
    samplePayload: any;
    sampleHeaders: Record<string, string>;
  }> {
    let samplePayload: any = {};
    let sampleHeaders: Record<string, string> = {};

    if (platform === 'shopify') {
      sampleHeaders = {
        'x-shopify-topic': topic,
        'x-shopify-shop-domain': 'test-shop.myshopify.com',
        'x-shopify-webhook-id': '12345',
        'x-shopify-api-version': '2024-01',
        'x-shopify-hmac-sha256': 'test-hmac',
        'content-type': 'application/json',
      };

      switch (topic) {
        case 'products/create':
        case 'products/update':
          samplePayload = {
            id: 123456789,
            title: 'Test Product',
            handle: 'test-product',
            status: 'active',
            variants: [
              {
                id: 987654321,
                sku: 'TEST-SKU-001',
                price: '19.99',
                inventory_quantity: 100,
              }
            ],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          break;

        case 'products/delete':
          samplePayload = {
            id: 123456789,
            title: 'Deleted Product',
            handle: 'deleted-product',
          };
          break;

        case 'inventory_levels/update':
          samplePayload = {
            inventory_item_id: 987654321,
            location_id: 123123123,
            available: 85,
            updated_at: new Date().toISOString(),
          };
          break;

        default:
          samplePayload = {
            id: 123456789,
            message: `Sample payload for ${topic}`,
            timestamp: new Date().toISOString(),
          };
      }
    }

    return {
      platform,
      topic,
      samplePayload,
      sampleHeaders,
    };
  }
} 