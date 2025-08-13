import {
  Controller,
  Post,
  Param,
  Req,
  Res,
  Headers,
  Body,
  HttpCode,
  HttpStatus,
  Logger,
  BadRequestException,
  UnauthorizedException,
  RawBodyRequest,
  InternalServerErrorException,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { ConfigService } from '@nestjs/config';
import { ActivityLogService } from '../common/activity-log.service';
import * as crypto from 'crypto';

@Controller('webhook')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(
    private syncCoordinator: SyncCoordinatorService,
    private configService: ConfigService,
    private activityLogService: ActivityLogService,
  ) {}

  @Post(':platform')
  @HttpCode(HttpStatus.OK)
  async handlePlatformWebhook(
    @Param('platform') platform: string,
    @Headers() headers: Record<string, string>,
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
  ): Promise<void> {
    const startTime = Date.now();
    const webhookId = `wh_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    this.logger.log(`[${webhookId}] Received webhook for platform: ${platform}`);
    this.logger.debug(`[${webhookId}] Headers: ${JSON.stringify(this.sanitizeHeaders(headers))}`);

    const rawBody = req.rawBody;
    if (!rawBody) {
      const errorMsg = 'Request body is missing or not in raw format';
      this.logger.warn(`[${webhookId}] ${errorMsg}`);
      res.status(HttpStatus.BAD_REQUEST).json({
        error: 'Bad Request',
        message: errorMsg,
        webhookId,
      });
      return;
    }

    let validatedPayload: any;
    const platformLower = platform.toLowerCase();
    let shopIdentifier: string | null = null;

    try {
      // Platform-specific validation and parsing
      switch (platformLower) {
        case 'shopify':
          const result = await this.validateShopifyWebhook(rawBody, headers, webhookId);
          validatedPayload = result.payload;
          shopIdentifier = result.shopIdentifier;
          break;

        case 'clover':
          const cloverResult = await this.validateCloverWebhook(rawBody, headers, webhookId);
          validatedPayload = cloverResult.payload;
          shopIdentifier = cloverResult.merchantIdentifier;
          break;

        case 'square':
          const squareResult = await this.validateSquareWebhook(rawBody, headers, webhookId);
          validatedPayload = squareResult.payload;
          shopIdentifier = squareResult.merchantIdentifier;
          break;

        default:
          this.logger.warn(`[${webhookId}] Unsupported platform: ${platform}`);
          res.status(HttpStatus.BAD_REQUEST).json({
            error: 'Bad Request',
            message: `Platform ${platform} not supported`,
            webhookId,
          });
          return;
      }

      // Send immediate 200 OK response
      res.status(HttpStatus.OK).json({
        received: true,
        webhookId,
        platform: platformLower,
        timestamp: new Date().toISOString(),
      });

      // Log webhook receipt for audit
      await this.activityLogService.logActivity({
        UserId: 'system', // Will be updated when we identify the user
        EntityType: 'Webhook',
        EntityId: webhookId,
        EventType: 'WEBHOOK_RECEIVED',
        Status: 'Info',
        Message: `Webhook received from ${platformLower}${shopIdentifier ? ` (${shopIdentifier})` : ''}`,
        Details: {
          platform: platformLower,
          shopIdentifier,
          processingTime: Date.now() - startTime,
          payloadSize: rawBody.length,
        }
      });

      // Process webhook asynchronously
      this.processWebhookAsync(platformLower, validatedPayload, headers, webhookId, shopIdentifier)
        .then(() => {
          this.logger.log(`[${webhookId}] Webhook processing completed successfully`);
        })
        .catch(err => {
          this.logger.error(`[${webhookId}] Webhook processing failed: ${err.message}`, err.stack);
        });

    } catch (error) {
      this.logger.error(`[${webhookId}] Webhook validation error: ${error.message}`, error.stack);
      
      if (!res.headersSent) {
        if (error instanceof UnauthorizedException) {
          res.status(HttpStatus.UNAUTHORIZED).json({
            error: 'Unauthorized',
            message: error.message,
            webhookId,
          });
        } else if (error instanceof BadRequestException) {
          res.status(HttpStatus.BAD_REQUEST).json({
            error: 'Bad Request',
            message: error.message,
            webhookId,
          });
        } else {
          res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
            error: 'Internal Server Error',
            message: 'Error processing webhook',
            webhookId,
          });
        }
      }
    }
  }

  // Optional route variant that includes a connectionId path param (used by some webhook registrations)
  @Post(':platform/:connectionId')
  @HttpCode(HttpStatus.OK)
  async handlePlatformWebhookWithConnection(
    @Param('platform') platform: string,
    @Param('connectionId') connectionId: string,
    @Headers() headers: Record<string, string>,
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
  ): Promise<void> {
    const startTime = Date.now();
    const webhookId = `wh_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.logger.log(`[${webhookId}] Received webhook for platform: ${platform} (conn ${connectionId})`);
    const rawBody = req.rawBody;
    if (!rawBody) {
      res.status(HttpStatus.BAD_REQUEST).json({ error: 'Bad Request', message: 'Request body is missing or not in raw format', webhookId });
      return;
    }
    const platformLower = platform.toLowerCase();
    try {
      let validatedPayload: any;
      let shopIdentifier: string | null = null;
      switch (platformLower) {
        case 'shopify': {
          const result = await this.validateShopifyWebhook(rawBody, headers, webhookId);
          validatedPayload = result.payload;
          shopIdentifier = result.shopIdentifier;
          break;
        }
        case 'clover': {
          const { payload, merchantIdentifier } = await this.validateCloverWebhook(rawBody, headers, webhookId);
          validatedPayload = payload;
          shopIdentifier = merchantIdentifier;
          break;
        }
        case 'square': {
          const { payload, merchantIdentifier } = await this.validateSquareWebhook(rawBody, headers, webhookId);
          validatedPayload = payload;
          shopIdentifier = merchantIdentifier;
          break;
        }
        default:
          res.status(HttpStatus.BAD_REQUEST).json({ error: 'Bad Request', message: `Platform ${platform} not supported`, webhookId });
          return;
      }

      res.status(HttpStatus.OK).json({ received: true, webhookId, platform: platformLower, timestamp: new Date().toISOString() });

      await this.activityLogService.logActivity({
        UserId: 'system',
        EntityType: 'Webhook',
        EntityId: webhookId,
        EventType: 'WEBHOOK_RECEIVED',
        Status: 'Info',
        Message: `Webhook received from ${platformLower} (explicit connection)`,
        Details: { platform: platformLower, shopIdentifier, connectionId, processingTime: Date.now() - startTime, payloadSize: rawBody.length }
      });

      // Process with explicit connectionId
      this.processWebhookAsync(platformLower, validatedPayload, headers, webhookId, shopIdentifier, connectionId)
        .then(() => this.logger.log(`[${webhookId}] Webhook processing completed successfully (conn ${connectionId})`))
        .catch(err => this.logger.error(`[${webhookId}] Webhook processing failed (conn ${connectionId}): ${err.message}`, err.stack));
    } catch (error) {
      this.logger.error(`[${webhookId}] Webhook validation error: ${error.message}`, error.stack);
      if (!res.headersSent) {
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: 'Internal Server Error', message: 'Error processing webhook', webhookId });
      }
    }
  }

  private async processWebhookAsync(
    platform: string,
    payload: any,
    headers: Record<string, string>,
    webhookId: string,
    shopIdentifier: string | null,
    connectionId?: string,
  ): Promise<void> {
    try {
      await this.syncCoordinator.handleWebhook(platform, payload, headers, webhookId, connectionId);
      
      // Log successful processing
      await this.activityLogService.logActivity({
        UserId: 'system',
        EntityType: 'Webhook',
        EntityId: webhookId,
        EventType: 'WEBHOOK_PROCESSED',
        Status: 'Success',
        Message: `Webhook ${webhookId} processed successfully`,
        Details: { platform, shopIdentifier }
      });
    } catch (error) {
      this.logger.error(`[${webhookId}] Error in async webhook processing: ${error.message}`, error.stack);
      
      // Log processing failure
      await this.activityLogService.logActivity({
        UserId: 'system',
        EntityType: 'Webhook',
        EntityId: webhookId,
        EventType: 'WEBHOOK_PROCESSING_FAILED',
        Status: 'Error',
        Message: `Webhook processing failed: ${error.message}`,
        Details: { platform, shopIdentifier, error: error.message }
      });
    }
  }

  private async validateShopifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string>,
    webhookId: string,
  ): Promise<{ payload: any; shopIdentifier: string }> {
    const shopifyHmac = headers['x-shopify-hmac-sha256'];
    const shopifyShopDomain = headers['x-shopify-shop-domain'];
    const shopifyTopic = headers['x-shopify-topic'];

    if (!shopifyHmac) {
      throw new UnauthorizedException('Shopify HMAC signature missing');
    }

    if (!shopifyShopDomain) {
      throw new BadRequestException('Shopify shop domain missing');
    }

    if (!this.verifyShopifyWebhook(rawBody, shopifyHmac)) {
      this.logger.error(`[${webhookId}] Shopify HMAC verification failed for shop: ${shopifyShopDomain}`);
      throw new UnauthorizedException('Invalid Shopify HMAC signature');
    }

    this.logger.log(`[${webhookId}] Shopify webhook verified - Topic: ${shopifyTopic}, Shop: ${shopifyShopDomain}`);

    return {
      payload: JSON.parse(rawBody.toString('utf8')),
      shopIdentifier: shopifyShopDomain,
    };
  }

  private async validateCloverWebhook(
    rawBody: Buffer,
    headers: Record<string, string>,
    webhookId: string,
  ): Promise<{ payload: any; merchantIdentifier: string | null }> {
    // Clover webhook validation
    const cloverMerchantId = headers['x-clover-merchant-id'] || headers['merchant-id'];
    
    try {
      const payload = JSON.parse(rawBody.toString('utf8'));
      const merchantId = cloverMerchantId || payload.merchant_id || payload.merchantId;
      
      this.logger.log(`[${webhookId}] Clover webhook validated for merchant: ${merchantId}`);
      
      return {
        payload,
        merchantIdentifier: merchantId,
      };
    } catch (error) {
      throw new BadRequestException('Invalid Clover webhook payload');
    }
  }

  private async validateSquareWebhook(
    rawBody: Buffer,
    headers: Record<string, string>,
    webhookId: string,
  ): Promise<{ payload: any; merchantIdentifier: string | null }> {
    const squareSignature = headers['x-square-signature'];
    const squareHmacSha256 = headers['x-square-hmacsha256-signature'];
    
    // Use HMAC SHA256 signature if available (newer Square webhooks)
    if (squareHmacSha256) {
      const webhookSignatureKey = this.configService.get<string>('SQUARE_WEBHOOK_SIGNATURE_KEY');
      if (webhookSignatureKey && !this.verifySquareWebhookHmac(rawBody, squareHmacSha256, webhookSignatureKey)) {
        throw new UnauthorizedException('Invalid Square HMAC signature');
      }
    }

    try {
      const payload = JSON.parse(rawBody.toString('utf8'));
      const merchantId = payload.merchant_id || payload.event?.merchant_id || headers['x-square-merchant-id'];
      
      this.logger.log(`[${webhookId}] Square webhook validated for merchant: ${merchantId}`);
      
      return {
        payload,
        merchantIdentifier: merchantId,
      };
    } catch (error) {
      throw new BadRequestException('Invalid Square webhook payload');
    }
  }

  private verifyShopifyWebhook(rawBody: Buffer, hmacHeader: string): boolean {
    const shopifySecret = this.configService.get<string>('SHOPIFY_API_SECRET');
    if (!shopifySecret) {
      this.logger.error('SHOPIFY_API_SECRET not configured - cannot verify webhook');
      return false;
    }

    const calculatedHmac = crypto
      .createHmac('sha256', shopifySecret)
      .update(rawBody)
      .digest('base64');

    try {
      return crypto.timingSafeEqual(Buffer.from(calculatedHmac), Buffer.from(hmacHeader));
    } catch (error) {
      this.logger.error(`HMAC verification error: ${error.message}`);
      return false;
    }
  }

  private verifySquareWebhookHmac(rawBody: Buffer, signature: string, signingKey: string): boolean {
    const expectedSignature = crypto
      .createHmac('sha256', signingKey)
      .update(rawBody)
      .digest('base64');

    try {
      return crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(signature));
    } catch (error) {
      this.logger.error(`Square HMAC verification error: ${error.message}`);
      return false;
    }
  }

  private sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
    const sanitized = { ...headers };
    // Remove sensitive headers from logs
    delete sanitized['authorization'];
    delete sanitized['x-shopify-hmac-sha256'];
    delete sanitized['x-square-signature'];
    delete sanitized['x-square-hmacsha256-signature'];
    return sanitized;
  }
}
