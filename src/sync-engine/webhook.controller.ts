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
  RawBodyRequest, // Import RawBodyRequest
} from '@nestjs/common';
import { Response, Request } from 'express'; // Keep Express types
import { SyncCoordinatorService } from './sync-coordinator.service';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Controller('webhook')
export class WebhookController {
    private readonly logger = new Logger(WebhookController.name);

  constructor(
    private syncCoordinator: SyncCoordinatorService,
    private configService: ConfigService,
  ) {}

  @Post(':platform')
  @HttpCode(HttpStatus.OK) // Respond with 200 OK quickly for webhooks
    async handlePlatformWebhook(
        @Param('platform') platform: string,
        @Headers() headers: Record<string, string>,
    @Req() req: RawBodyRequest<Request>, // Use RawBodyRequest
    @Res() res: Response, // Inject Response to send custom response
  ): Promise<void> {
    this.logger.log(`Received webhook for platform: ${platform} with headers: ${JSON.stringify(headers)}`);

    const rawBody = req.rawBody; // Access the raw body
        if (!rawBody) {
      this.logger.warn('Webhook received without a raw body. Ensure body-parser is configured correctly for raw bodies on this route.');
      // Send response before throwing to avoid hanging
      res.status(HttpStatus.BAD_REQUEST).send('Request body is missing or not in raw format.');
      throw new BadRequestException('Request body is missing or not in raw format.');
    }

    let validatedPayload: any;
    const platformLower = platform.toLowerCase();

    try {
      switch (platformLower) {
        case 'shopify':
          const shopifyHmac = headers['x-shopify-hmac-sha256'];
          const shopifyShopDomain = headers['x-shopify-shop-domain'];
          const shopifyTopic = headers['x-shopify-topic'];
          this.logger.log(`Shopify Webhook: Topic: ${shopifyTopic}, Shop: ${shopifyShopDomain}`);
          
          if (!shopifyHmac) {
            throw new UnauthorizedException('Shopify HMAC signature missing.');
          }
          if (!this.verifyShopifyWebhook(rawBody, shopifyHmac)) {
            throw new UnauthorizedException('Invalid Shopify HMAC signature.');
          }
          this.logger.log('Shopify HMAC signature verified successfully.');
          validatedPayload = JSON.parse(rawBody.toString('utf8'));
          break;

        case 'clover':
          // TODO: Implement Clover webhook verification if applicable (e.g., specific headers, IP allowlisting, or signed messages if supported)
          this.logger.log('Processing Clover webhook (verification pending).');
          validatedPayload = JSON.parse(rawBody.toString('utf8'));
          break;

        case 'square':
          const squareSignature = headers['x-square-signature'];
          // TODO: Implement Square webhook signature verification
          // You'll need the webhook signing secret from Square and the full URL of your webhook endpoint.
          // const webhookUrl = this.configService.get('APP_URL') + req.originalUrl;
          // if (!this.verifySquareWebhook(rawBody, squareSignature, webhookUrl)) {
          //   throw new UnauthorizedException('Invalid Square signature.');
          // }
          this.logger.log('Processing Square webhook (verification pending).');
          validatedPayload = JSON.parse(rawBody.toString('utf8'));
          break;

        default:
          this.logger.warn(`Received webhook for unsupported platform: ${platform}`);
          res.status(HttpStatus.BAD_REQUEST).send(`Platform ${platform} not supported`);
          throw new BadRequestException(`Platform ${platform} not supported`);
      }

      // If validation passed, send OK response immediately before processing
      res.status(HttpStatus.OK).send('Webhook received successfully.');

      // Asynchronously process the webhook to avoid holding up the response to the platform
      this.syncCoordinator.handleWebhook(platformLower, validatedPayload, headers) // Pass headers for context
        .then(() => {
          this.logger.log(`Webhook processing initiated for ${platformLower}.`);
        })
        .catch(err => {
          this.logger.error(`Error initiating webhook processing for ${platformLower}: ${err.message}`, err.stack);
          // This error occurs after we've already sent 200 OK. Log it for monitoring.
        });

    } catch (error) {
      this.logger.error(`Webhook validation or initial processing error for ${platform}: ${error.message}`, error.stack);
      if (!res.headersSent) {
        if (error instanceof UnauthorizedException) {
            res.status(HttpStatus.UNAUTHORIZED).send(error.message);
        } else if (error instanceof BadRequestException) {
            res.status(HttpStatus.BAD_REQUEST).send(error.message);
        } else {
            res.status(HttpStatus.INTERNAL_SERVER_ERROR).send('Error processing webhook.');
        }
      }
      // Do not re-throw if response already sent, but ensure error is logged.
      // If response not sent, re-throwing is fine if NestJS handles it gracefully.
      if (!res.headersSent) throw error; 
    }
  }

     private verifyShopifyWebhook(rawBody: Buffer, hmacHeader?: string): boolean {
    if (!hmacHeader) return false;

    const shopifySecret = this.configService.get<string>('SHOPIFY_API_SECRET');
    if (!shopifySecret) {
      this.logger.error('SHOPIFY_API_SECRET is not configured. Cannot verify Shopify webhook.');
      return false; // Cannot verify without the secret
             }

            const calculatedHmac = crypto
      .createHmac('sha256', shopifySecret)
                .update(rawBody)
                .digest('base64');
    
    this.logger.debug(`[Shopify Webhook Verify] Received HMAC: ${hmacHeader}, Calculated HMAC: ${calculatedHmac}`);

    // Use timingSafeEqual for security
    try {
            return crypto.timingSafeEqual(Buffer.from(calculatedHmac), Buffer.from(hmacHeader));
    } catch (e) {
        this.logger.error(`Error during timingSafeEqual for Shopify HMAC: ${e.message}`);
            return false;
        }
    }

  // private verifySquareWebhook(rawBody: Buffer, signature: string, webhookUrl: string): boolean {
  //   const secret = this.configService.get<string>('SQUARE_WEBHOOK_SIGNATURE_KEY');
  //   if (!secret) {
  //     this.logger.error('SQUARE_WEBHOOK_SIGNATURE_KEY is not configured.');
  //     return false;
  //   }
  //   const hmac = crypto.createHmac('sha256', secret);
  //   hmac.update(webhookUrl + rawBody.toString('utf8')); // Use utf8 string of rawBody for Square
  //   const hash = hmac.digest('base64');
  //   this.logger.debug(`[Square Webhook Verify] Received Sig: ${signature}, Calculated Sig: ${hash}, Webhook URL: ${webhookUrl}`);
  //   return hash === signature;
  // }
}
