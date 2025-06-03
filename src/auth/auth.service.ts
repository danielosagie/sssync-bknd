import {
  Injectable,
  InternalServerErrorException,
  BadRequestException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { SupabaseService } from '../common/supabase.service';
import { EncryptionService } from '../common/encryption.service';
import axios from 'axios';
import { randomBytes } from 'crypto';
import { SupabaseClient, PostgrestSingleResponse } from '@supabase/supabase-js';
import { StatePayload } from './interfaces/state-payload.interface';

// Define the shape of the state JWT payload
interface PlatformConnectionInput {
  UserId: string;
  PlatformType: string;
  DisplayName: string;
  Credentials: Record<string, any>; // Store encrypted credentials as JSON object
  Status: string;
  IsEnabled: boolean;
  LastSyncSuccessAt?: string;
  PlatformSpecificData?: Record<string, any>; // Optional field for other IDs etc.
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name); // Initialize logger
  private readonly jwtSecret: string;
  private readonly stateTokenExpiry: string = '5m'; // Example expiry for state token

  constructor(
    private readonly configService: ConfigService,
    private readonly supabaseService: SupabaseService,
    private readonly encryptionService: EncryptionService,
    private readonly jwtService: JwtService, // Inject JwtService
  ) {
    this.jwtSecret = this.configService.get<string>('JWT_SECRET')!;
    if (!this.jwtSecret) {
      throw new Error('JWT_SECRET environment variable is not set');
    }
  }

  // --- State Management ---

  /**
   * Generates a short-lived JWT to use as the state parameter.
   */
  private generateStateJwt(payload: Omit<StatePayload, 'nonce'>): string {
    const nonce = randomBytes(16).toString('hex');
    const statePayload: StatePayload = { ...payload, nonce };
    return this.jwtService.sign(statePayload);
  }

  /**
   * Verifies the state JWT received during callback. PUBLIC access.
   * @throws BadRequestException if JWT is invalid, expired, or platform mismatch.
   */
  public verifyStateJwt(stateJwt: string, expectedPlatform: StatePayload['platform']): StatePayload {
    try {
      const payload = this.jwtService.verify<StatePayload>(stateJwt, { secret: this.jwtSecret });
      if (payload.platform !== expectedPlatform) {
        throw new Error('Platform mismatch in state');
      }
      return payload;
    } catch (error) {
      this.logger.error(`State JWT verification failed: ${error.message}`, error.stack);
      this.logger.warn(`State JWT verification failed: ${error.message}`);
      if (error.name === 'TokenExpiredError') {
        throw new UnauthorizedException('State expired. Please try logging in again.');
      }
      throw new UnauthorizedException(`Invalid state parameter: ${error.message}`);
    }
  }

  // --- Common Platform Connection Saving ---

  /**
   * Upserts platform connection details into Supabase.
   */
  private async savePlatformConnection(
    input: PlatformConnectionInput,
  ): Promise<PostgrestSingleResponse<any>> {
    // Use service client to bypass RLS for backend connection management
    const supabase = this.supabaseService.getServiceClient();

    const encryptedCredentials = this.encryptionService.encrypt(input.Credentials);

    const connectionData = {
      UserId: input.UserId,
      PlatformType: input.PlatformType,
      DisplayName: input.DisplayName,
      Credentials: encryptedCredentials, // Save the encrypted string/object
      Status: input.Status,
      IsEnabled: input.IsEnabled,
      LastSyncSuccessAt: input.LastSyncSuccessAt ?? new Date().toISOString(),
      PlatformSpecificData: input.PlatformSpecificData, // Store extra info if needed
      UpdatedAt: new Date().toISOString(),
    };

    // Use the exact column names from your sssync-db.md schema
    const { data, error } = await supabase
      .from('PlatformConnections') // Ensure this table name is correct
      .upsert(connectionData, { onConflict: 'UserId, PlatformType' }) // Adjust conflict columns if needed
      .select()
      .single();

    if (error) {
      this.logger.error(
        `Failed to save ${input.PlatformType} connection for user ${input.UserId}: ${error.message}`,
        error,
      );
      throw new InternalServerErrorException(
        `Could not save ${input.PlatformType} platform connection.`,
        error.message,
      );
    }

    this.logger.log(
      `${input.PlatformType} connection saved successfully for user: ${input.UserId}`,
    );
    return data;
  }

  // --- Shopify ---

  /**
   * Constructs the URL for the generic Shopify Accounts store login/picker page.
   * Embeds the necessary info (userId, finalRedirectUri) in the state parameter.
   */
  getShopifyStoreLoginUrl(userId: string, appFinalRedirectUri: string): string {
    this.logger.log(`Generating Shopify Store Login URL for user ${userId}, final app URI: ${appFinalRedirectUri}`);
    const accountsBaseUrl = 'https://accounts.shopify.com';
    const intermediateCallbackPath = '/auth/shopify/store-picker-callback';

    const apiBaseUrl = this.configService.get<string>('HOST_NAME');
    if (!apiBaseUrl) {
        this.logger.error('HOST_NAME is not configured. Cannot build intermediate callback URL.');
        throw new InternalServerErrorException('Server configuration error: HOST_NAME missing.');
    }

    let fullApiBase = apiBaseUrl;
    if (!fullApiBase.startsWith('http://') && !fullApiBase.startsWith('https://')) {
        fullApiBase = `https://${apiBaseUrl}`;
    } else if (fullApiBase.startsWith('http://')) {
        this.logger.warn(`HOST_NAME uses http:// (${fullApiBase}). Shopify callbacks require https://.`);
    }

    let intermediateCallbackUrl: URL;
    try {
         intermediateCallbackUrl = new URL(intermediateCallbackPath, fullApiBase);
    } catch (e) {
         this.logger.error(`Failed to construct intermediate callback URL object from base '${fullApiBase}' and path '${intermediateCallbackPath}': ${e.message}`);
         throw new InternalServerErrorException('Failed to construct internal callback URL.');
    }

    const statePayload: Omit<StatePayload, 'nonce' | 'shop'> = {
        userId,
        platform: 'shopify-intermediate',
        finalRedirectUri: appFinalRedirectUri,
    };
    const state = this.generateStateJwt(statePayload);

    const storeLoginUrl = new URL('/store-login', accountsBaseUrl);
    storeLoginUrl.searchParams.set('redirect_uri', intermediateCallbackUrl.toString());
    storeLoginUrl.searchParams.set('state', state);

    this.logger.debug(`Constructed Store Login URL: ${storeLoginUrl.toString()}`);
    this.logger.debug(`Intermediate Redirect URI for Store Login: ${intermediateCallbackUrl.toString()}`);
    this.logger.debug(`State for Store Login: ${state}`);
    return storeLoginUrl.toString();
  }

  getShopifyAuthUrl(shop: string, userId: string, finalRedirectUri: string): string {
    const apiKey = this.configService.get<string>('SHOPIFY_API_KEY');
    const scopes = this.configService.get<string>('SHOPIFY_SCOPES');
    const redirectUri = this.configService.get<string>('SHOPIFY_REDIRECT_URI');

    this.logger.debug(`[AuthService.getShopifyAuthUrl] Entered. Shop: ${shop}, UserID: ${userId}, finalRedirectUri (for state): ${finalRedirectUri}`);
    this.logger.debug(`[AuthService.getShopifyAuthUrl] Configured API_BASE_URL: ${this.configService.get<string>('API_BASE_URL')}`);
    this.logger.debug(`[AuthService.getShopifyAuthUrl] Configured SHOPIFY_API_KEY: ${this.configService.get<string>('SHOPIFY_API_KEY')}`);
    this.logger.debug(`[AuthService.getShopifyAuthUrl] Configured SHOPIFY_SCOPES: ${this.configService.get<string>('SHOPIFY_SCOPES')}`); 

    if (!apiKey || !scopes || !redirectUri || !shop) {
      throw new InternalServerErrorException('Shopify configuration is missing or invalid.');
    }

    const statePayload: Omit<StatePayload, 'nonce'> = {
      userId,
      platform: 'shopify',
      shop,
      finalRedirectUri,
    };
    const state = this.generateStateJwt(statePayload);

    let shopDomain = shop;
    if (!shopDomain.includes('.myshopify.com')) {
      shopDomain = `${shop}.myshopify.com`;
    }

    const authUrl = new URL(`https://${shopDomain}/admin/oauth/authorize`);
    authUrl.searchParams.set('client_id', apiKey);
    authUrl.searchParams.set('scope', scopes);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);

    return authUrl.toString();
  }

  async handleShopifyCallback(code: string, shop: string, state: string): Promise<void> {
    this.logger.log(`Handling Shopify callback for shop: ${shop}`);
    let statePayload: StatePayload;
    try {
      statePayload = this.verifyStateJwt(state, 'shopify');

      if (!statePayload.shop) {
        throw new BadRequestException('Shop parameter missing in state payload.');
      }

      const normalizedStateShop = statePayload.shop.includes('.myshopify.com')
           ? statePayload.shop
           : `${statePayload.shop}.myshopify.com`;

      if (normalizedStateShop !== shop) {
        throw new BadRequestException(`State shop parameter mismatch. Expected ${normalizedStateShop}, received ${shop}`);
      }
      this.logger.debug(`State verified for shop: ${shop}, userId: ${statePayload.userId}`);

      const apiKey = this.configService.get<string>('SHOPIFY_API_KEY');
      const apiSecret = this.configService.get<string>('SHOPIFY_API_SECRET');
      if (!apiKey || !apiSecret) throw new InternalServerErrorException('Shopify configuration error.');

      const tokenUrl = `https://${shop}/admin/oauth/access_token`;
      const tokenPayload = {
        client_id: apiKey,
        client_secret: apiSecret,
        code,
      };

      const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(tokenPayload),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        this.logger.error(`Shopify token exchange failed for shop ${shop}. Status: ${response.status}. Body: ${errorBody}`);
        throw new InternalServerErrorException(`Failed to exchange Shopify code for token. Status: ${response.status}`);
      }

      const tokenData = await response.json();
      if (!tokenData.access_token) {
        this.logger.error(`Shopify token exchange response missing access_token for shop ${shop}. Response: ${JSON.stringify(tokenData)}`);
        throw new InternalServerErrorException('Invalid token response from Shopify.');
      }

      this.logger.log(`Successfully obtained Shopify access token for shop: ${shop}`);

      await this.savePlatformConnection({
        UserId: statePayload.userId,
        PlatformType: 'shopify',
        DisplayName: shop,
        Credentials: { accessToken: tokenData.access_token },
        Status: 'Connected',
        IsEnabled: true,
        PlatformSpecificData: { shop: shop },
      });
      this.logger.log(`Platform connection saved/updated for Shopify shop: ${shop}, userId: ${statePayload.userId}`);
  

    } catch (error) {
    
      this.logger.error(`Error handling Shopify callback for shop ${shop}: ${error.message}`, error.stack);
      throw error;
    }
  }

  // --- Clover ---

  getCloverAuthUrl(userId: string, finalRedirectUriForState: string): string {
    const clientId = this.configService.get<string>('CLOVER_APP_ID');
    const backendCallbackUrl = this.configService.get<string>('CLOVER_REDIRECT_URI'); 

    if (!clientId || !backendCallbackUrl) {
      this.logger.error('Clover APP_ID or REDIRECT_URI is not configured.');
      throw new InternalServerErrorException('Clover configuration is missing or invalid.');
    }

    const statePayload: Omit<StatePayload, 'nonce' | 'shop'> = {
      userId,
      platform: 'clover',
      finalRedirectUri: finalRedirectUriForState, 
    };
    const state = this.generateStateJwt(statePayload);

    // Use a specific config for the authorization base URL
    const cloverAuthBaseUrl = this.configService.get<string>('CLOVER_AUTHORIZATION_BASE_URL'); 
    if (!cloverAuthBaseUrl) {
        this.logger.error('CLOVER_AUTHORIZATION_BASE_URL is not configured.');
        throw new InternalServerErrorException('Clover authorization endpoint configuration is missing.');
    }

    const authUrl = new URL('/oauth/authorize', cloverAuthBaseUrl); // For v1 OAuth, or /oauth/v2/authorize for v2
    // If using v2, ensure this path is /oauth/v2/authorize
    // const authUrl = new URL('/oauth/v2/authorize', cloverAuthBaseUrl);
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri', backendCallbackUrl); 
    authUrl.searchParams.set('state', state);

    this.logger.log(`Generated Clover Auth URL: ${authUrl.toString()}`);
    return authUrl.toString();
  }

  async handleCloverCallback(code: string, merchantId: string, userIdFromState: string, finalRedirectUriForState: string): Promise<void> {
    this.logger.log(`Handling Clover callback for merchantId: ${merchantId}, userId from state: ${userIdFromState}`);

    const clientId = this.configService.get<string>('CLOVER_APP_ID');
    const clientSecret = this.configService.get<string>('CLOVER_APP_SECRET');
    const backendCallbackUrl = this.configService.get<string>('CLOVER_REDIRECT_URI');

    if (!clientId || !clientSecret || !backendCallbackUrl) {
      this.logger.error('Clover configuration (APP_ID, APP_SECRET, or REDIRECT_URI) is missing.');
      throw new InternalServerErrorException('Clover OAuth configuration error on server.');
    }

    // Use a specific config for the token endpoint base URL
    const cloverTokenBaseUrl = this.configService.get<string>('CLOVER_TOKEN_ENDPOINT_BASE_URL');
    if (!cloverTokenBaseUrl) {
        this.logger.error('CLOVER_TOKEN_ENDPOINT_BASE_URL is not configured.');
        throw new InternalServerErrorException('Clover token endpoint configuration is missing.');
    }
    // Adjust path for v2 if necessary
    const cloverTokenUrl = `${cloverTokenBaseUrl}/oauth/token`; // For v1, or /oauth/v2/token for v2
    // const cloverTokenUrl = `${cloverTokenBaseUrl}/oauth/v2/token`;


    try {
      const tokenResponse = await axios.post<{ access_token: string }>(
        cloverTokenUrl,
        null, // Clover token request typically sends params in query string, not body for code exchange
        {
          params: {
            client_id: clientId,
            client_secret: clientSecret,
            code: code,
            grant_type: 'authorization_code', // Though often not explicitly needed if using 'code'
            redirect_uri: backendCallbackUrl, // Sometimes required by OAuth providers in token request
          },
          headers: {
            'Accept': 'application/json',
          },
        },
      );

      if (!tokenResponse.data || !tokenResponse.data.access_token) {
        this.logger.error('Clover token exchange failed: No access_token in response.', tokenResponse.data);
        throw new InternalServerErrorException('Failed to obtain access token from Clover.');
      }

      const accessToken = tokenResponse.data.access_token;
      this.logger.log(`Successfully obtained Clover access token for merchant: ${merchantId}`);

      // Encrypt and save credentials
      const credentials = {
        accessToken: accessToken,
        merchantId: merchantId, // Store merchantId with credentials
      };

      // Fetch merchant details to get a display name (optional, but good UX)
      let displayName = `Clover (${merchantId.substring(0, 7)}...)`; // Fallback display name
      try {
          // Use the CLOVER_API_BASE_URL (general API) for fetching merchant details
          const cloverApiBaseUrl = this.configService.get<string>('CLOVER_API_BASE_URL');
          if (!cloverApiBaseUrl) {
              this.logger.warn('CLOVER_API_BASE_URL not configured, cannot fetch merchant name.');
          } else {
            const merchantDetailsUrl = `${cloverApiBaseUrl}/v3/merchants/${merchantId}`;
            const merchantDetailsResponse = await axios.get<{name?: string}>(merchantDetailsUrl, {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });
            if (merchantDetailsResponse.data?.name) {
                displayName = merchantDetailsResponse.data.name;
            }
          }
      } catch (e) {
          this.logger.warn(`Could not fetch Clover merchant name for ${merchantId}: ${e.message}`);
      }


      await this.savePlatformConnection({
        UserId: userIdFromState, // Use userId from the verified state
        PlatformType: 'clover',
        DisplayName: displayName,
        Credentials: credentials,
        Status: 'needs_review', // Or 'syncing' if you auto-start scan
        IsEnabled: true,
        PlatformSpecificData: { merchantId: merchantId },
      });

      this.logger.log(`Clover connection successfully processed and saved for user ${userIdFromState}, merchant ${merchantId}.`);

    } catch (error) {
      this.logger.error(
        `Error during Clover token exchange or saving connection for merchant ${merchantId}: ${error.response?.data || error.message}`,
        error.stack,
      );
      if (axios.isAxiosError(error) && error.response) {
          throw new InternalServerErrorException(
              `Clover API error (${error.response.status}): ${JSON.stringify(error.response.data)}`,
          );
      }
      throw new InternalServerErrorException('Failed to process Clover authentication.');
    }
  }

  // --- Square ---

  getSquareAuthUrl(userId: string, finalRedirectUri: string): string {
    const appId = this.configService.get<string>('SQUARE_APP_ID');
    const redirectUri = this.configService.get<string>('SQUARE_REDIRECT_URI');
    const scopes = this.configService.get<string>('SQUARE_SCOPES');
    const squareAuthBaseUrl = 'https://connect.squareup.com'; // Use Square's production base URL

    if (!appId || !redirectUri || !scopes) {
      throw new InternalServerErrorException('Square configuration is missing or invalid.');
    }

    const statePayload: Omit<StatePayload, 'nonce'> = {
      userId,
      platform: 'square',
      finalRedirectUri,
    };
    const state = this.generateStateJwt(statePayload);

    const authUrl = new URL('/oauth2/authorize', squareAuthBaseUrl);
    authUrl.searchParams.set('client_id', appId);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', scopes);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);

    return authUrl.toString();
  }

  async handleSquareCallback(code: string, state: string): Promise<void> {
    this.logger.log(`Handling Square callback.`);
    let statePayload: StatePayload;
    try {
      statePayload = this.verifyStateJwt(state, 'square');
      this.logger.debug(`State verified for Square auth, userId: ${statePayload.userId}`);

      const appId = this.configService.get<string>('SQUARE_APP_ID');
      const appSecret = this.configService.get<string>('SQUARE_APP_SECRET');
      const redirectUri = this.configService.get<string>('SQUARE_REDIRECT_URI');
      const squareAuthBaseUrl = this.configService.get<string>('SQUARE_API_BASE', 'https://connect.squareup.com');
      if (!appId || !appSecret || !redirectUri) throw new InternalServerErrorException('Square configuration error.');

      const tokenUrl = new URL('/oauth2/token', squareAuthBaseUrl);
      const tokenPayload = {
        client_id: appId,
        client_secret: appSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      };

      const response = await fetch(tokenUrl.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Square-Version': '2023-10-18',
        },
        body: JSON.stringify(tokenPayload),
      });

      if (!response.ok) {
        const errorBody = await response.json();
        this.logger.error(`Square token exchange failed. Status: ${response.status}. Body: ${JSON.stringify(errorBody)}`);
        throw new InternalServerErrorException(`Failed to exchange Square code for token. Error: ${errorBody?.errors?.[0]?.detail || response.statusText}`);
      }
      const tokenData = await response.json();
      if (!tokenData.access_token) {
        this.logger.error(`Square token exchange response missing access_token. Response: ${JSON.stringify(tokenData)}`);
        throw new InternalServerErrorException('Invalid token response from Square.');
      }
      this.logger.log(`Successfully obtained Square access token for userId: ${statePayload.userId}`);

      await this.savePlatformConnection({
        UserId: statePayload.userId,
        PlatformType: 'square',
        DisplayName: `Square (${tokenData.merchant_id || 'Account'})`,
        Credentials: {
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token,
          expiresAt: tokenData.expires_at,
        },
        Status: 'Connected',
        IsEnabled: true,
        PlatformSpecificData: { merchantId: tokenData.merchant_id },
      });
      this.logger.log(`Platform connection saved/updated for Square merchant: ${tokenData.merchant_id}, userId: ${statePayload.userId}`);

    } catch (error) {
      this.logger.error(`Error handling Square callback: ${error.message}`, error.stack);
      throw error;
    }
  }
}
