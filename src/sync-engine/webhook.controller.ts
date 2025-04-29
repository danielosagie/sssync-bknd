import { Controller, Post, Body, Param, Headers, Request, RawBodyRequest, Logger, UnauthorizedException, InternalServerErrorException } from '@nestjs/common';
import { SyncCoordinatorService } from './sync-coordinator.service'; // Adjust path
import * as crypto from 'crypto'; // For signature verification

@Controller('webhooks')
export class WebhookController {
    private readonly logger = new Logger(WebhookController.name);

    constructor(private syncCoordinator: SyncCoordinatorService) {}

    @Post(':platform') // e.g., /webhooks/shopify
    async handlePlatformWebhook(
        @Param('platform') platform: string,
        @Headers('x-shopify-hmac-sha256') shopifyHmac: string, // Example for Shopify
        // Add other platform-specific headers as needed
        @Headers() headers: Record<string, string>,
        @Request() req: RawBodyRequest<Request>, // Need raw body for signature verification
        // @Body() body: any, // Use raw body instead if signature needed
    ): Promise<{ received: boolean }> {
        this.logger.log(`Received webhook for platform: ${platform}`);
        const rawBody = req.rawBody; // Access raw body if configured in main.ts (bodyParser: false / rawBody: true)

        // <<< FIX: Check if rawBody exists >>>
        if (!rawBody) {
            this.logger.error(`Raw body missing for webhook from ${platform}. Ensure rawBody:true is set in main.ts and request has body.`);
            // Consider throwing BadRequestException or InternalServerErrorException
            throw new InternalServerErrorException('Missing raw body for webhook processing');
        }

        // --- 1. Verify Webhook Signature (CRUCIAL) ---
        let isValid = false;
        if (platform.toLowerCase() === 'shopify') {
            isValid = this.verifyShopifyWebhook(rawBody, shopifyHmac);
        } // else if (platform.toLowerCase() === 'square') { ... }
        else {
            this.logger.warn(`Webhook signature verification not implemented for platform: ${platform}`);
             isValid = true; // Allow for now during dev? Or reject? Safer to reject.
             // throw new UnauthorizedException(`Verification not supported for ${platform}`);
        }

        if (!isValid) {
            this.logger.error(`Invalid webhook signature for platform ${platform}`);
            throw new UnauthorizedException('Invalid webhook signature');
        }
        this.logger.debug(`Webhook signature verified for ${platform}`);
        // --- End Verification ---

        // --- 2. Process Payload (Queue Job Recommended) ---
        const body = JSON.parse(rawBody.toString()); // Parse body *after* signature verification
        // TODO: Queue a job for SyncCoordinatorService instead of processing directly
        await this.syncCoordinator.handleWebhook(platform, body);

        return { received: true };
    }


     private verifyShopifyWebhook(rawBody: Buffer, hmacHeader?: string): boolean {
        if (!rawBody || !hmacHeader) return false;
        try {
            // TODO: Get SHOPIFY_API_SECRET from ConfigService
            const secret = process.env.SHOPIFY_API_SECRET || ''; // Get securely!
             if (!secret) {
                this.logger.error('SHOPIFY_API_SECRET not configured for webhook verification.');
                return false;
             }
            const calculatedHmac = crypto
                .createHmac('sha256', secret)
                .update(rawBody)
                .digest('base64');
            return crypto.timingSafeEqual(Buffer.from(calculatedHmac), Buffer.from(hmacHeader));
        } catch (error) {
            this.logger.error(`Error verifying Shopify webhook: ${error.message}`);
            return false;
        }
    }
}
