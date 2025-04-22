import {
  Controller,
  Get,
  Query,
  Res,
  UnauthorizedException,
  BadRequestException,
  Logger,
  Req, // Keep Req if needed for future auth guards
  InternalServerErrorException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config'; // Import ConfigService
import { AuthService } from './auth.service';
import { Response, Request } from 'express';
import * as crypto from 'crypto'; // Import crypto for HMAC verification


// Helper function to build redirect URL
const buildRedirectUrl = (base: string, platform: string, success: boolean, error?: string) => {
  const url = new URL(base, 'https://api.sssync.app/'); // Base URL for frontend dashboard/settings
  url.searchParams.set('connection', platform);
  url.searchParams.set('status', success ? 'success' : 'error');
  if (error) {
    url.searchParams.set('message', error);
  }
  return url.pathname + url.search; // Return relative path with query params
};

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  private readonly frontendRedirectBase = '/dashboard'; // Base path for frontend redirects

  constructor(
      private readonly authService: AuthService,
      private readonly configService: ConfigService, // Inject ConfigService
  ) {}

  // --- Shopify Endpoints ---
  @Get('shopify/login')
  async shopifyLogin(
    @Query('userId') userId: string, // !!! TEMPORARY/INSECURE: Get userId from query param !!!
    @Query('shop') shop: string,
    @Res() res: Response,
  ) {
    this.logger.log(`Shopify login requested for user: ${userId}, shop: ${shop}`);
    // !!! WARNING: Passing userId via query param is INSECURE for production. !!!
    // !!! Implement proper authentication (e.g., JWT guard) to get userId. !!!
    if (!userId) {
      throw new BadRequestException('Temporary: userId query parameter is required.');
    }
    if (!shop || !shop.endsWith('.myshopify.com')) {
      throw new BadRequestException(
        'Shop query parameter ending with .myshopify.com is required.',
      );
    }

    try {
        const authUrl = this.authService.getShopifyAuthUrl(shop, userId);
        res.redirect(authUrl);
    } catch (error) {
        this.logger.error(`Shopify login error for user ${userId}: ${error.message}`, error.stack);
        res.redirect(buildRedirectUrl(this.frontendRedirectBase, 'shopify', false, 'Configuration error'));
    }
  }

  @Get('shopify/callback')
  async shopifyCallback(
    @Query() query: { code: string; shop: string; state: string; hmac: string; timestamp: string },
    @Res() res: Response,
  ) {
    const { code, shop, state, hmac, timestamp } = query;
    this.logger.log(`Received Shopify callback for shop: ${shop}`);

    if (!code || !shop || !state || !hmac || !timestamp) {
      throw new BadRequestException('Missing required parameters from Shopify callback.');
    }

    // 1. Verify HMAC
    const shopifyApiSecret = this.configService.get<string>('SHOPIFY_API_SECRET');
    // Explicitly check if secret exists before calling verification
    if (!shopifyApiSecret) {
      this.logger.error('SHOPIFY_API_SECRET is not configured. Cannot verify HMAC.');
      // Throw 500 because this is a server config issue
      throw new InternalServerErrorException('Server configuration error preventing HMAC verification.');
    }
    // Now shopifyApiSecret is guaranteed to be a string here
    if (!this.verifyShopifyHmac(query, shopifyApiSecret)) {
      this.logger.error(`Invalid HMAC for Shopify callback. Shop: ${shop}`);
      throw new UnauthorizedException('Invalid HMAC signature.');
    }
    this.logger.log(`HMAC verified successfully for shop: ${shop}`);

    // 2. Handle OAuth flow via Service
    try {
      await this.authService.handleShopifyCallback(code, shop, state);
      this.logger.log(`Shopify OAuth successful for shop: ${shop}, redirecting...`);
      res.redirect(buildRedirectUrl(this.frontendRedirectBase, 'shopify', true));
    } catch (error) {
      this.logger.error(`Shopify callback processing error for shop ${shop}: ${error.message}`, error.stack);
      const userMessage = error instanceof BadRequestException ? error.message : 'Failed to connect Shopify account.';
      res.redirect(buildRedirectUrl(this.frontendRedirectBase, 'shopify', false, userMessage));
    }
  }

  // --- Clover Endpoints ---
  @Get('clover/login')
  async cloverLogin(
    @Query('userId') userId: string, // !!! TEMPORARY/INSECURE: Get userId from query param !!!
    @Res() res: Response,
  ) {
    this.logger.log(`Clover login requested for user: ${userId}`);
    // !!! WARNING: Passing userId via query param is INSECURE for production. !!!
    if (!userId) {
      throw new BadRequestException('Temporary: userId query parameter is required.');
    }
    try {
        const authUrl = this.authService.getCloverAuthUrl(userId);
        res.redirect(authUrl);
    } catch (error) {
        this.logger.error(`Clover login error for user ${userId}: ${error.message}`, error.stack);
        res.redirect(buildRedirectUrl(this.frontendRedirectBase, 'clover', false, 'Configuration error'));
    }
  }

  @Get('clover/callback')
  async cloverCallback(
    // Clover provides merchant_id and client_id along with code and state
    @Query() query: { code: string; state: string; merchant_id: string; client_id: string },
    @Res() res: Response,
  ) {
    const { code, state, merchant_id, client_id } = query;
    this.logger.log(`Received Clover callback for merchant: ${merchant_id}`);

    if (!code || !state || !merchant_id || !client_id) {
      throw new BadRequestException('Missing required parameters from Clover callback.');
    }

    // TODO: Optional - Verify client_id matches your app ID for extra security
    const expectedAppId = this.configService.get<string>('CLOVER_APP_ID');
    if (client_id !== expectedAppId) {
        this.logger.error(`Client ID mismatch in Clover callback. Expected ${expectedAppId}, got ${client_id}`);
        throw new UnauthorizedException('Client ID mismatch.');
    }

    try {
      await this.authService.handleCloverCallback(code, merchant_id, state);
      this.logger.log(`Clover OAuth successful for merchant: ${merchant_id}, redirecting...`);
      res.redirect(buildRedirectUrl(this.frontendRedirectBase, 'clover', true));
    } catch (error) {
      this.logger.error(`Clover callback processing error for merchant ${merchant_id}: ${error.message}`, error.stack);
       const userMessage = error instanceof BadRequestException ? error.message : 'Failed to connect Clover account.';
      res.redirect(buildRedirectUrl(this.frontendRedirectBase, 'clover', false, userMessage));
    }
  }

  // --- Square Endpoints ---
  @Get('square/login')
  async squareLogin(
    @Query('userId') userId: string, // !!! TEMPORARY/INSECURE: Get userId from query param !!!
    @Res() res: Response,
  ) {
    this.logger.log(`Square login requested for user: ${userId}`);
     // !!! WARNING: Passing userId via query param is INSECURE for production. !!!
    if (!userId) {
      throw new BadRequestException('Temporary: userId query parameter is required.');
    }
    try {
        const authUrl = this.authService.getSquareAuthUrl(userId);
        res.redirect(authUrl);
    } catch (error) {
        this.logger.error(`Square login error for user ${userId}: ${error.message}`, error.stack);
        res.redirect(buildRedirectUrl(this.frontendRedirectBase, 'square', false, 'Configuration error'));
    }
  }

  @Get('square/callback')
  async squareCallback(
    // Square provides code and state. May also include 'response_type=code' param, which we ignore.
    @Query() query: { code: string; state: string; error?: string; error_description?: string },
    @Res() res: Response,
  ) {
    const { code, state, error: sqError, error_description } = query;
    this.logger.log(`Received Square callback.`);

    // Handle explicit errors from Square
    if (sqError) {
        this.logger.error(`Error received from Square callback: ${sqError} - ${error_description}`);
        throw new BadRequestException(`Square authorization failed: ${error_description || sqError}`);
    }

    if (!code || !state) {
      throw new BadRequestException('Missing code or state parameter from Square callback.');
    }

    try {
      await this.authService.handleSquareCallback(code, state);
      this.logger.log(`Square OAuth successful, redirecting...`);
      res.redirect(buildRedirectUrl(this.frontendRedirectBase, 'square', true));
    } catch (error) {
      this.logger.error(`Square callback processing error: ${error.message}`, error.stack);
       const userMessage = error instanceof BadRequestException ? error.message : 'Failed to connect Square account.';
      res.redirect(buildRedirectUrl(this.frontendRedirectBase, 'square', false, userMessage));
    }
  }

  // --- Helper Methods ---

  /**
   * Verifies the HMAC signature from Shopify callback.
   */
  private verifyShopifyHmac(query: Record<string, any>, apiSecret: string): boolean { // Accept `any` for query values
    if (!apiSecret) {
        this.logger.error('Cannot verify Shopify HMAC: SHOPIFY_API_SECRET is not configured.');
        return false; // Cannot verify without secret
    }
    const receivedHmac = query.hmac;
    if (typeof receivedHmac !== 'string') {
        this.logger.warn('Received Shopify callback without a valid string HMAC.');
        return false;
    }

    // Create string from query params (excluding hmac itself, ensuring values are strings)
    const queryString = Object.keys(query)
      .filter((key) => key !== 'hmac' && typeof query[key] === 'string') // Ensure value is string
      .sort()
      .map((key) => `${key}=${query[key]}`)
      .join('&');

    // Calculate HMAC digest
    const calculatedHmac = crypto
      .createHmac('sha256', apiSecret)
      .update(queryString)
      .digest('hex');

    // Use timingSafeEqual for security
    try {
      return crypto.timingSafeEqual(Buffer.from(receivedHmac, 'hex'), Buffer.from(calculatedHmac, 'hex'));
    } catch (e) {
        // Handle potential errors if buffers have different lengths or invalid hex chars
        this.logger.error('Error during timingSafeEqual comparison for Shopify HMAC', e);
        return false;
    }
  }
}
