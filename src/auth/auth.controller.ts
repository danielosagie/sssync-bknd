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
    this.logger.log(`Received Shopify callback for shop: ${query.shop}`);
    // Define statePayload outside try to access it in catch block
    let statePayload: StatePayload | null = null;
    let errorRedirectTarget = this.frontendRedirectBase; // Default redirect target on error

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
       // If state is verified, update the error redirect target immediately
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
      @Query('state') state: string, // <<< ADD state query parameter >>>
      @Res() res: Response,
  ) {
      // <<< FIX: Validate presence of shop and state >>>
      if (!shop || !state) {
         throw new BadRequestException('Missing required parameters (shop or state) from Shopify store picker callback.');
      }

      // <<< FIX: Verify state JWT and extract data >>>
      let statePayload: StatePayload;
      let userId: string;
      let finalRedirectUri: string;
      try {
          // Expecting the intermediate state type here
          statePayload = this.authService.verifyStateJwt(state, 'shopify-intermediate');
          userId = statePayload.userId;
          finalRedirectUri = statePayload.finalRedirectUri;
          this.logger.log(`Received Shopify Store Picker callback for shop: ${shop}, user: ${userId}, final app URI: ${finalRedirectUri}`);
      } catch (error) {
           this.logger.error(`Invalid state received in store picker callback: ${error.message}`);
           // Redirect back to a known base or the (potentially untrusted) finalRedirectUri with error
           // Since finalRedirectUri might be compromised if state is bad, redirecting to default base is safer.
           const errorRedirect = buildRedirectUrl(this.frontendRedirectBase, 'shopify', false, 'Invalid state received during login.');
           res.redirect(errorRedirect);
           return; // Stop execution
      }

      try {
        // Now use the *original* getShopifyAuthUrl service method to build the
        // final authorization URL for the *specific* shop, passing the final app URI through.
        // This method will generate a *new* state JWT for the final OAuth step.
        const finalAuthUrl = this.authService.getShopifyAuthUrl(shop, userId, finalRedirectUri);
        this.logger.debug(`Redirecting user to final shop-specific auth URL: ${finalAuthUrl}`);
        res.redirect(finalAuthUrl);
      } catch (error) {
         this.logger.error(`Error constructing final shop-specific auth URL for ${shop}: ${error.message}`, error.stack);
         // Redirect back to the app's final URI (retrieved from verified state) with an error message
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
     const redirectTarget = finalRedirectUri || this.frontendRedirectBase;
     this.logger.log(`Initiating Clover login for userId: ${userId}, redirecting to: ${redirectTarget}`);
    try {
        // Pass redirectTarget to the service method
        const authUrl = this.authService.getCloverAuthUrl(userId, redirectTarget);
        res.redirect(authUrl);
    } catch (error) {
        this.logger.error(`Error generating Clover auth URL: ${error.message}`, error.stack);
        const errorRedirect = buildRedirectUrl(redirectTarget, 'clover', false, 'Configuration error initiating OAuth flow.');
        res.redirect(errorRedirect);
    }
  }

  @Get('clover/callback')
  async cloverCallback(
    @Query() query: { code?: string; state: string; merchant_id?: string; client_id?: string }, // merchant_id might be missing on error
    @Res() res: Response,
  ) {
    this.logger.log(`Received Clover callback.`);
    let statePayload: StatePayload | null = null;
    let errorRedirectTarget = this.frontendRedirectBase;

    try {
        // Clover might not send merchant_id/client_id on user denial or error
        if (!query.code || !query.state) {
           // Check if it's an explicit denial (this might vary based on Clover's exact response)
           if (query.state && !query.code) { // Assuming state is present but code is missing indicates denial/error
                try {
                   // Still try to verify state to get the redirect URI
                   statePayload = this.authService.verifyStateJwt(query.state, 'clover');
                   errorRedirectTarget = statePayload.finalRedirectUri;
                   this.logger.warn(`Clover OAuth denied by user or error before code grant. State: ${query.state}`);
                   throw new UnauthorizedException('User denied access or Clover returned an error.');
                } catch (stateError) {
                    // If state verification also fails
                    this.logger.error(`Clover callback error: Missing code and failed state verification. State: ${query.state}`, stateError.stack);
                    throw new BadRequestException('Invalid callback parameters or invalid/expired state.');
                }
           } else {
               // Both code and state are missing or other essential params
               this.logger.error(`Clover callback error: Missing required parameters. Query: ${JSON.stringify(query)}`);
               throw new BadRequestException('Missing required parameters in Clover callback.');
           }
        }
        // We need merchant_id for linking, even if client_id isn't strictly needed for logic here
        if (!query.merchant_id) {
             this.logger.error(`Clover callback error: Missing merchant_id. Query: ${JSON.stringify(query)}`);
             throw new BadRequestException('Missing merchant_id in Clover callback.');
        }

        // Verify client_id matches configuration (security check)
        const expectedClientId = this.configService.get<string>('CLOVER_APP_ID');
        if (!expectedClientId || query.client_id !== expectedClientId) {
            this.logger.error(`Clover callback error: Client ID mismatch. Expected ${expectedClientId}, Received ${query.client_id}`);
            throw new BadRequestException('Client ID mismatch.');
        }

        // Verify state JWT
        statePayload = this.authService.verifyStateJwt(query.state, 'clover');
        errorRedirectTarget = statePayload.finalRedirectUri; // Update error target
        this.logger.debug(`Clover State JWT verified. Final redirect target: ${statePayload.finalRedirectUri}`);

        // Handle OAuth flow
        await this.authService.handleCloverCallback(query.code, query.merchant_id, query.state);
        this.logger.log(`Clover OAuth flow completed successfully for merchant: ${query.merchant_id}, userId: ${statePayload.userId}`);

        // Redirect to success URL
        const successRedirect = buildRedirectUrl(statePayload.finalRedirectUri, 'clover', true);
        this.logger.log(`Redirecting to success URL: ${successRedirect}`);
        res.redirect(successRedirect);

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown OAuth error';
        this.logger.error(`Error during Clover callback: ${errorMessage}`, error.stack);

        let clientErrorMessage = 'OAuth flow failed.';
         if (error instanceof UnauthorizedException) {
             clientErrorMessage = 'Authentication failed or access denied.';
         } else if (error instanceof BadRequestException) {
             clientErrorMessage = `Invalid request: ${errorMessage}`;
         } else if (errorMessage.includes('State expired') || errorMessage.includes('Invalid state')) {
             clientErrorMessage = 'Login session invalid or expired, please try again.';
         }

        // Use the redirect target from state if available, otherwise default
        const errorRedirect = buildRedirectUrl(errorRedirectTarget, 'clover', false, clientErrorMessage);
        this.logger.log(`Redirecting to error URL: ${errorRedirect}`);
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
