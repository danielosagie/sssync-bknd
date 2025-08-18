import {
  Controller,
  Get,
  Post,
  Headers,
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
import { StatePayload } from './interfaces/state-payload.interface'; // Ensure this import is correct


// Helper function to build redirect URL - Revised for clarity and robustness
const buildRedirectUrl = (base: string, platform: string, success: boolean, error?: string): string => {
    const logger = new Logger('buildRedirectUrl'); // Add logger for debugging
    let finalUrl: URL;

    try {
        // Attempt to parse the base as is. This works for full URLs (http, https, custom schemes)
        finalUrl = new URL(base);
    } catch (e) {
        // If parsing fails, it might be a relative path intended for web redirects,
        // or simply an invalid base.
        logger.warn(`Provided base "${base}" is not a valid URL. Assuming it's a web path.`);

        // For web paths, we ideally need a configured frontend origin.
        // For now, we'll construct a relative path starting with '/'.
        // This relies on the client/browser context to resolve correctly.
        // Consider throwing an error or using a default origin from config for more robustness.
        const path = base.startsWith('/') ? base : `/${base}`;
        const params = new URLSearchParams();
        params.set('connection', platform);
        params.set('status', success ? 'success' : 'error');
        if (error) {
            params.set('message', error);
        }
        return `${path}?${params.toString()}`; // Return relative path + query
    }

    // If parsing succeeded, append parameters to the existing URL object
    try {
        finalUrl.searchParams.set('connection', platform);
        finalUrl.searchParams.set('status', success ? 'success' : 'error');
        if (error) {
            finalUrl.searchParams.set('message', error);
        }
        return finalUrl.toString(); // Return the full URL string
    } catch (urlError) {
         logger.error(`Error appending search params to URL object for base "${base}": ${urlError.message}`);
         // Fallback in case of unexpected error during param setting
         const fallbackParams = new URLSearchParams();
         fallbackParams.set('connection', platform);
         fallbackParams.set('status', 'error');
         fallbackParams.set('message', 'Internal redirect generation error');
         return `/?${fallbackParams.toString()}`; // Redirect to root with generic error
    }
};

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  private readonly frontendRedirectBase: string; // Base URL/path for frontend redirects

  constructor(
      private readonly authService: AuthService,
      private readonly configService: ConfigService, // Inject ConfigService
  ) {
     // Initialize from environment variables or default
     this.frontendRedirectBase = this.configService.get<string>('FRONTEND_REDIRECT_BASE', 'http://localhost:3000/auth/callback'); // Example default
  }

  // --- Clerk → Supabase token exchange ---
  @Post('exchange')
  async exchange(@Headers('authorization') authHeader?: string) {
    const bearer = authHeader?.split(' ');
    const token = bearer && bearer[0] === 'Bearer' ? bearer[1] : undefined;
    if (!token) {
      throw new BadRequestException('Missing Authorization: Bearer <clerk_token>');
    }
    return this.authService.exchangeClerkTokenForSupabase(token);
  }

  // --- Clerk Webhooks (users/orgs) ---
  @Post('clerk/webhooks')
  async clerkWebhooks(@Headers('svix-id') svixId: string | undefined,
    @Headers('svix-timestamp') svixTimestamp: string | undefined,
    @Headers('svix-signature') svixSignature: string | undefined,
    @Req() req: any) {
    // Optional: verify via SVIX if you configure Clerk webhooks with secret
    // For now, handle basic events to mirror Users; expand to orgs later.
    const event = req.body;
    // Expected types: 'user.created', 'user.updated', 'user.deleted', 'organization.created', 'organizationMembership.created', ...
    return this.authService.handleClerkWebhook(event);
  }

  // --- Shopify Endpoints ---
  @Get('shopify/login')
  async shopifyLogin(
    @Query('userId') userId: string,
    @Query('shop') shop: string,
    @Res() res: Response,
    @Query('finalRedirectUri') finalRedirectUri?: string,
  ) {
    if (!userId || !shop) {
      throw new BadRequestException('Missing required query parameters: userId and shop.');
    }
    // Determine the redirect target: use provided URI or the default base.
    const redirectTarget = finalRedirectUri || this.frontendRedirectBase;
    this.logger.log(`Initiating Shopify login for userId: ${userId}, shop: ${shop}, redirecting to: ${redirectTarget}`);

    try {
        this.logger.debug(`[AuthController.shopifyLogin] About to call authService.getShopifyAuthUrl with shop: ${shop}, userId: ${userId}, redirectTarget: ${redirectTarget}`);
        // Pass the *intended* final redirect URI to the service method
        const authUrl = this.authService.getShopifyAuthUrl(shop, userId, redirectTarget);
        res.redirect(authUrl);
    } catch (error) {
        this.logger.error(`Error generating Shopify auth URL: ${error.message}`, error.stack);
        // Redirect to the *intended* final target even on configuration error
        const errorRedirect = buildRedirectUrl(redirectTarget, 'shopify', false, 'Configuration error initiating OAuth flow.');
        res.redirect(errorRedirect);
    }
  }

  @Get('shopify/callback')
  async shopifyCallback(
    @Query() query: { code: string; shop: string; state: string; hmac: string; timestamp: string },
    @Res() res: Response,
  ) {
    this.logger.log(`Received Shopify callback for shop: ${query.shop} to /shopify/callback`);
    let statePayload: StatePayload | null = null;
    let errorRedirectTarget = this.frontendRedirectBase;

    try {
      if (!query.code || !query.state || !query.shop || !query.hmac || !query.timestamp) {
        throw new BadRequestException('Missing required parameters in Shopify callback.');
      }

       // 1. Verify HMAC first (as per Shopify docs)
       const shopifyApiSecret = this.configService.get<string>('SHOPIFY_API_SECRET');
       if (!shopifyApiSecret) {
           this.logger.error('SHOPIFY_API_SECRET is not configured.');
           throw new InternalServerErrorException('Server configuration error.');
       }
       if (!this.verifyShopifyHmac(query, shopifyApiSecret)) {
           this.logger.warn(`Invalid HMAC received for shop: ${query.shop}`);
           throw new UnauthorizedException('Invalid HMAC signature.');
       }
       this.logger.debug('Shopify HMAC verified successfully.');

       // 2. Verify state JWT and extract payload (including finalRedirectUri)
       statePayload = this.authService.verifyStateJwt(query.state, 'shopify');
       errorRedirectTarget = statePayload.finalRedirectUri;
       this.logger.debug(`State JWT verified. Final redirect target: ${statePayload.finalRedirectUri}`);

      // 3. Handle the OAuth code exchange and token storage via Service
      await this.authService.handleShopifyCallback(query.code, query.shop, query.state);
      this.logger.log(`Shopify OAuth flow completed successfully for shop: ${query.shop}, userId: ${statePayload.userId}`);

      // 4. Redirect to the final destination specified in the state
      const successRedirect = buildRedirectUrl(statePayload.finalRedirectUri, 'shopify', true);
      this.logger.log(`Redirecting to success URL: ${successRedirect}`);
      res.redirect(successRedirect);

    } catch (error) {
        // Log the specific error
        const errorMessage = error instanceof Error ? error.message : 'Unknown OAuth error';
        this.logger.error(`Error during Shopify callback for shop ${query.shop}: ${errorMessage}`, error.stack);

        // Determine the user-facing error message
        let clientErrorMessage = 'OAuth flow failed.';
        if (error instanceof UnauthorizedException) {
            clientErrorMessage = 'Authentication failed (Invalid signature).';
        } else if (error instanceof BadRequestException) {
            clientErrorMessage = `Invalid request: ${errorMessage}`;
        } else if (errorMessage.includes('State expired')) {
            clientErrorMessage = 'Login session expired, please try again.';
        } else if (errorMessage.includes('Invalid state')) {
             clientErrorMessage = 'Invalid login session, please try again.';
        }

        // Use the redirect target from the state if available, otherwise the default.
        // errorRedirectTarget is set inside the try block *after* state verification,
        // or defaults to frontendRedirectBase if state verification fails or doesn't happen.
        const errorRedirect = buildRedirectUrl(errorRedirectTarget, 'shopify', false, clientErrorMessage);
        this.logger.log(`Redirecting to error URL: ${errorRedirect}`);
        res.redirect(errorRedirect);
    }
  }

  /**
   * Initiates the Shopify Store Login/Picker flow.
   * Called by the mobile app.
   * Redirects user to Shopify Accounts to login and pick store.
   */
  @Get('shopify/initiate-store-picker')
  async shopifyInitiateStorePicker(
    @Query('userId') userId: string,
    @Query('finalRedirectUri') finalRedirectUri: string, // Expecting the app's custom scheme URI
    @Res() res: Response,
  ) {
    if (!userId || !finalRedirectUri) {
      throw new BadRequestException('Missing required query parameters: userId and finalRedirectUri.');
    }
    // Basic validation for custom scheme (optional but recommended)
    if (!finalRedirectUri.includes('://')) {
         this.logger.warn(`Invalid finalRedirectUri provided for store picker: ${finalRedirectUri}. Expected a URI with a scheme.`);
         // Redirect back to the potentially invalid URI with an error?
         // Or throw? Throwing is safer.
         throw new BadRequestException('Invalid finalRedirectUri format. Expected a full URI with a custom scheme.');
    }

    this.logger.log(`Initiating Shopify Store Picker flow for userId: ${userId}, final app URI: ${finalRedirectUri}`);

    try {
        const storeLoginUrl = this.authService.getShopifyStoreLoginUrl(userId, finalRedirectUri);
        res.redirect(storeLoginUrl);
    } catch (error) {
        this.logger.error(`Error generating Shopify Store Login URL: ${error.message}`, error.stack);
        // Redirect back to the app's final URI with an error message
        const errorRedirect = buildRedirectUrl(finalRedirectUri, 'shopify', false, 'Configuration error initiating login flow.');
        res.redirect(errorRedirect);
    }
  }

  // --- Intermediate Callback for Store Picker ---
  /**
   * Intermediate callback from Shopify Accounts after store selection.
   * Constructs the final OAuth URL for the specific shop and redirects.
   */
  @Get('shopify/store-picker-callback')
  async shopifyStorePickerCallback(
      @Query('shop') shop: string, // Provided by Shopify Accounts
      @Query('state') state: string,
      @Res() res: Response,
      @Req() req: Request // <<< Inject original request for more details
  ) {
      this.logger.log(`>>> ENTERING /auth/shopify/store-picker-callback <<<`);
      this.logger.debug(`Store Picker Callback Raw Query: ${JSON.stringify(req.query)}`); // Log raw query
      this.logger.debug(`Store Picker Callback Headers: ${JSON.stringify(req.headers)}`); // Log headers (useful for debugging proxies/IPs)

      if (!shop || !state) {
         // Log the failure reason more clearly
         this.logger.error(`Store Picker Callback missing required parameters. Shop: ${shop}, State: ${state}`);
         throw new BadRequestException('Missing required parameters (shop or state) from Shopify store picker callback.');
      }

      let statePayload: StatePayload;
      let userId: string;
      let finalRedirectUri: string;
      try {
          this.logger.debug(`Store Picker Callback attempting to verify state: ${state}`);
          statePayload = this.authService.verifyStateJwt(state, 'shopify-intermediate');
          userId = statePayload.userId;
          finalRedirectUri = statePayload.finalRedirectUri;
          this.logger.log(`Store Picker Callback state VERIFIED. Shop: ${shop}, User: ${userId}, Final URI: ${finalRedirectUri}`);
      } catch (error) {
           this.logger.error(`Invalid state received in store picker callback: ${error.message}. State JWT: ${state}`);
           const errorRedirect = buildRedirectUrl(this.frontendRedirectBase, 'shopify', false, 'Invalid state received during login.');
           res.redirect(errorRedirect);
           return;
      }

      try {
        this.logger.debug(`Store Picker Callback attempting to get final auth URL for shop: ${shop}`);
        const finalAuthUrl = this.authService.getShopifyAuthUrl(shop, userId, finalRedirectUri);
        this.logger.log(`Store Picker Callback SUCCESS. Redirecting to final auth URL: ${finalAuthUrl}`);
        res.redirect(finalAuthUrl);
      } catch (error) {
         this.logger.error(`Store Picker Callback FAILED to construct final shop-specific auth URL for ${shop}: ${error.message}`, error.stack);
         const errorRedirect = buildRedirectUrl(finalRedirectUri, 'shopify', false, 'Error preparing shop authorization.');
         res.redirect(errorRedirect);
      }
  }

  // --- Clover Endpoints ---
  @Get('clover/login')
  async cloverLogin(
    @Query('userId') userId: string,
    @Res() res: Response,
    @Query('finalRedirectUri') finalRedirectUri?: string,
  ) {
     if (!userId) {
       throw new BadRequestException('Missing required query parameter: userId.');
     }
    // Use the provided finalRedirectUri, or default if it's for a web flow without one explicitly set
    const effectiveFinalRedirectUri = finalRedirectUri || this.frontendRedirectBase; // frontendRedirectBase could be your web app's main callback page

    this.logger.log(`Initiating Clover login for userId: ${userId}, final redirect target: ${effectiveFinalRedirectUri}`);
    try {
      // Pass userId AND the final (app/web) redirect URI to be stored in the state
      const authUrl = this.authService.getCloverAuthUrl(userId, effectiveFinalRedirectUri);
        res.redirect(authUrl);
    } catch (error) {
        this.logger.error(`Error generating Clover auth URL: ${error.message}`, error.stack);
      const errorRedirect = buildRedirectUrl(effectiveFinalRedirectUri, 'clover', false, 'Configuration error initiating OAuth flow.');
        res.redirect(errorRedirect);
    }
  }

  @Get('clover/callback')
  async cloverCallback(
    @Query() query: { code?: string; state?: string; merchant_id?: string; client_id?: string },
    @Res() res: Response,
  ) {
    this.logger.log(`Received Clover callback. Query: ${JSON.stringify(query)}`);
    let statePayload: StatePayload | null = null;
    // Default error redirect if state cannot be parsed early
    let errorRedirectTarget = this.frontendRedirectBase;

    try {
      if (!query.state) { // State is always expected, even on error from Clover
        throw new BadRequestException('Missing state parameter in Clover callback.');
      }

      // 1. Verify state JWT and extract payload (including finalRedirectUri)
                   statePayload = this.authService.verifyStateJwt(query.state, 'clover');
      // If state is verified, update the error redirect target immediately
                   errorRedirectTarget = statePayload.finalRedirectUri;
      this.logger.debug(`Clover callback: State JWT verified. Final redirect target set to: ${statePayload.finalRedirectUri}, UserID from state: ${statePayload.userId}`);

      // Check if Clover returned an error instead of a code
      if (!query.code && query.merchant_id) { // This condition implies an error if code is missing but merchant_id might still be there on some error scenarios
          // Clover might not always send a clear 'error' query param. Absence of 'code' when expected is an issue.
          // Or, if Clover has specific error query params, check for those.
          this.logger.warn(`Clover callback for user ${statePayload.userId}, merchant ${query.merchant_id} did not include an authorization code. Query: ${JSON.stringify(query)}`);
          throw new BadRequestException('Clover authorization failed or was denied by the user.');
      }
      if (!query.code || !query.merchant_id) {
           this.logger.error(`Clover callback missing code or merchant_id. Code: ${query.code}, MerchantId: ${query.merchant_id}`);
           throw new BadRequestException('Missing required parameters (code or merchant_id) in Clover callback.');
      }


      // 2. Handle OAuth code exchange and token storage
      // Pass userId from the verified state to handleCloverCallback
      await this.authService.handleCloverCallback(query.code, query.merchant_id, statePayload.userId, statePayload.finalRedirectUri /* Pass for logging/consistency if needed by service */);
        this.logger.log(`Clover OAuth flow completed successfully for merchant: ${query.merchant_id}, userId: ${statePayload.userId}`);

      // 3. Redirect to the final destination specified in the state
        const successRedirect = buildRedirectUrl(statePayload.finalRedirectUri, 'clover', true);
      this.logger.log(`Clover callback: Redirecting to success URL: ${successRedirect}`);
        res.redirect(successRedirect);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown OAuth error with Clover.';
        this.logger.error(`Error during Clover callback: ${errorMessage}`, error.stack);

      let clientErrorMessage = 'Clover OAuth flow failed.';
         if (error instanceof UnauthorizedException) {
          clientErrorMessage = `Authentication error: ${errorMessage}`;
         } else if (error instanceof BadRequestException) {
          clientErrorMessage = `Invalid request during Clover OAuth: ${errorMessage}`;
      } else if (errorMessage.includes('State expired')) {
          clientErrorMessage = 'Login session expired, please try connecting Clover again.';
      } else if (errorMessage.includes('Invalid state')) {
           clientErrorMessage = 'Invalid login session, please try connecting Clover again.';
         }
      // ErrorRedirectTarget would have been updated if state was parsed, otherwise defaults.
        const errorRedirect = buildRedirectUrl(errorRedirectTarget, 'clover', false, clientErrorMessage);
      this.logger.log(`Clover callback: Redirecting to error URL: ${errorRedirect}`);
        res.redirect(errorRedirect);
    }
  }

  // --- Square Endpoints ---
  @Get('square/login')
  async squareLogin(
    @Query('userId') userId: string,
    @Res() res: Response,
    @Query('finalRedirectUri') finalRedirectUri?: string,
  ) {
     if (!userId) {
       throw new BadRequestException('Missing required query parameter: userId.');
     }
     const redirectTarget = finalRedirectUri || this.frontendRedirectBase;
     this.logger.log(`Initiating Square login for userId: ${userId}, redirecting to: ${redirectTarget}`);
    try {
        // Pass redirectTarget to the service method
        const authUrl = this.authService.getSquareAuthUrl(userId, redirectTarget);
        res.redirect(authUrl);
    } catch (error) {
        this.logger.error(`Error generating Square auth URL: ${error.message}`, error.stack);
        const errorRedirect = buildRedirectUrl(redirectTarget, 'square', false, 'Configuration error initiating OAuth flow.');
        res.redirect(errorRedirect);
    }
  }

  // --- eBay Endpoints ---
  @Get('ebay/login')
  async ebayLogin(
    @Query('userId') userId: string,
    @Res() res: Response,
    @Query('finalRedirectUri') finalRedirectUri?: string,
  ) {
    if (!userId) {
      throw new BadRequestException('Missing required query parameter: userId.');
    }
    const redirectTarget = finalRedirectUri || this.frontendRedirectBase;
    this.logger.log(`Initiating eBay login for userId: ${userId}, redirecting to: ${redirectTarget}`);
    try {
      const authUrl = this.authService.getEbayAuthUrl(userId, redirectTarget);
      res.redirect(authUrl);
    } catch (error) {
      this.logger.error(`Error generating eBay auth URL: ${error.message}`, error.stack);
      const errorRedirect = buildRedirectUrl(redirectTarget, 'ebay', false, 'eBay OAuth not configured.');
      res.redirect(errorRedirect);
    }
  }

  @Get('ebay/callback')
  async ebayCallback(
    @Query() query: { code?: string; state?: string; error?: string; error_description?: string },
    @Res() res: Response,
  ) {
    this.logger.log('Received eBay callback');
    let errorRedirectTarget = this.frontendRedirectBase;
    try {
      if (query.error) {
        this.logger.warn(`eBay callback error: ${query.error} - ${query.error_description}`);
        throw new UnauthorizedException(query.error_description || query.error);
      }
      if (!query.code || !query.state) {
        throw new BadRequestException('Missing required parameters in eBay callback.');
      }
      const statePayload = this.authService.verifyStateJwt(query.state, 'ebay');
      errorRedirectTarget = statePayload.finalRedirectUri;
      await this.authService.handleEbayCallback(query.code, query.state);
      const successRedirect = buildRedirectUrl(statePayload.finalRedirectUri, 'ebay', true);
      res.redirect(successRedirect);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'OAuth error';
      this.logger.error(`Error during eBay callback: ${msg}`);
      const errorRedirect = buildRedirectUrl(errorRedirectTarget, 'ebay', false, msg);
      res.redirect(errorRedirect);
    }
  }

  // --- Facebook Endpoints ---
  @Get('facebook/login')
  async facebookLogin(
    @Query('userId') userId: string,
    @Res() res: Response,
    @Query('finalRedirectUri') finalRedirectUri?: string,
  ) {
    if (!userId) {
      throw new BadRequestException('Missing required query parameter: userId.');
    }
    const redirectTarget = finalRedirectUri || this.frontendRedirectBase;
    this.logger.log(`Initiating Facebook login for userId: ${userId}, redirecting to: ${redirectTarget}`);
    try {
      const authUrl = this.authService.getFacebookAuthUrl(userId, redirectTarget);
      res.redirect(authUrl);
    } catch (error) {
      this.logger.error(`Error generating Facebook auth URL: ${error.message}`, error.stack);
      const errorRedirect = buildRedirectUrl(redirectTarget, 'facebook', false, 'Facebook OAuth not configured.');
      res.redirect(errorRedirect);
    }
  }

  @Get('facebook/callback')
  async facebookCallback(
    @Query() query: { code?: string; state?: string; error?: string; error_description?: string },
    @Res() res: Response,
  ) {
    this.logger.log('Received Facebook callback');
    let errorRedirectTarget = this.frontendRedirectBase;
    try {
      if (query.error) {
        this.logger.warn(`Facebook callback error: ${query.error} - ${query.error_description}`);
        throw new UnauthorizedException(query.error_description || query.error);
      }
      if (!query.code || !query.state) {
        throw new BadRequestException('Missing required parameters in Facebook callback.');
      }
      const statePayload = this.authService.verifyStateJwt(query.state, 'facebook');
      errorRedirectTarget = statePayload.finalRedirectUri;
      await this.authService.handleFacebookCallback(query.code, query.state);
      const successRedirect = buildRedirectUrl(statePayload.finalRedirectUri, 'facebook', true);
      res.redirect(successRedirect);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'OAuth error';
      this.logger.error(`Error during Facebook callback: ${msg}`);
      const errorRedirect = buildRedirectUrl(errorRedirectTarget, 'facebook', false, msg);
      res.redirect(errorRedirect);
    }
  }
  @Get('square/callback')
  async squareCallback(
    // Square returns 'error' and 'error_description' query params on failure
    @Query() query: { code?: string; state: string; response_type?: string; error?: string; error_description?: string },
    @Res() res: Response,
  ) {
     this.logger.log(`Received Square callback.`);
     let statePayload: StatePayload | null = null;
     let errorRedirectTarget = this.frontendRedirectBase;

    try {
        // 1. Check for explicit errors from Square first
        if (query.error) {
            this.logger.warn(`Square callback returned error: ${query.error} - ${query.error_description}. State: ${query.state}`);
             // Try to verify state to get the intended redirect URI
             try {
                statePayload = this.authService.verifyStateJwt(query.state, 'square');
                errorRedirectTarget = statePayload.finalRedirectUri;
             } catch (stateError) {
                 this.logger.error(`Failed to verify state after Square returned an error. State: ${query.state}`, stateError);
                 // Fallback to default target if state is bad
             }
             // Throw an exception to be caught and trigger the error redirect
             throw new UnauthorizedException(query.error_description || query.error || 'Square OAuth Error');
        }

        // 2. Check for required parameters if no explicit error
        if (!query.code || !query.state) {
          this.logger.error(`Square callback missing required parameters (code or state). Query: ${JSON.stringify(query)}`);
          throw new BadRequestException('Missing required parameters in Square callback.');
        }

        // 3. Verify state JWT
        statePayload = this.authService.verifyStateJwt(query.state, 'square');
        errorRedirectTarget = statePayload.finalRedirectUri; // Update error target
        this.logger.debug(`Square State JWT verified. Final redirect target: ${statePayload.finalRedirectUri}`);

        // 4. Handle OAuth code exchange
        await this.authService.handleSquareCallback(query.code, query.state);
        this.logger.log(`Square OAuth flow completed successfully for userId: ${statePayload.userId}`);

        // 5. Redirect to success URL
        const successRedirect = buildRedirectUrl(statePayload.finalRedirectUri, 'square', true);
        this.logger.log(`Redirecting to success URL: ${successRedirect}`);
        res.redirect(successRedirect);

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown OAuth error';
        this.logger.error(`Error during Square callback: ${errorMessage}`, error.stack);

        let clientErrorMessage = 'OAuth flow failed.';
         if (error instanceof UnauthorizedException) {
             clientErrorMessage = `Authentication failed: ${errorMessage}`; // Include Square's error description if possible
         } else if (error instanceof BadRequestException) {
             clientErrorMessage = `Invalid request: ${errorMessage}`;
         } else if (errorMessage.includes('State expired') || errorMessage.includes('Invalid state')) {
             clientErrorMessage = 'Login session invalid or expired, please try again.';
         }

        // Use the redirect target derived from state if available, otherwise default
        const errorRedirect = buildRedirectUrl(errorRedirectTarget, 'square', false, clientErrorMessage);
        this.logger.log(`Redirecting to error URL: ${errorRedirect}`);
        res.redirect(errorRedirect);
    }
  }


  private verifyShopifyHmac(query: any, secret: string): boolean {
    const { hmac, ...params } = query; // Separate HMAC

    // Create key-value pairs and sort them alphabetically by key
    const messageParts = Object.keys(params)
      .sort()
      .map(key => {
        // IMPORTANT: Replace '&' and '%' in keys and values as per Shopify docs examples
        // (Though usually only needed if keys/values contain these chars, safer to include)
        // For simplicity here, we'll assume typical values don't need deep encoding,
        // but focus on the structure: key=value joined by &
        // If encoding IS needed: replace(/&/g, '%26').replace(/%/g, '%25') on key and params[key]
        return `${key}=${params[key]}`;
      });

    // Join the sorted pairs with '&'
    const message = messageParts.join('&');
    this.logger.debug(`[HMAC Verify] String to hash: ${message}`); // Log the string being hashed

    const calculatedHmac = crypto
      .createHmac('sha256', secret)
      .update(message) // Use the '&' joined message
      .digest('hex');

    this.logger.debug(`[HMAC Verify] Received: ${hmac}, Calculated: ${calculatedHmac}`);

    // Ensure comparison happens only if hmac is a string
    if (typeof hmac !== 'string' || hmac.length !== calculatedHmac.length) {
         this.logger.warn(`[HMAC Verify] Received HMAC is invalid or length mismatch.`);
         return false;
    }

    try {
        // Use timingSafeEqual to prevent timing attacks
        return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(calculatedHmac));
    } catch (e) {
         this.logger.error(`[HMAC Verify] Error during timingSafeEqual: ${e.message}`);
         return false; // Treat comparison errors as invalid
    }
  }
}
