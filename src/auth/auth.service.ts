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
import jwt from 'jsonwebtoken';
import jwkToPem from 'jwk-to-pem';
import { randomBytes } from 'crypto';
import { SupabaseClient, PostgrestSingleResponse } from '@supabase/supabase-js';
import { StatePayload } from './interfaces/state-payload.interface';
import { PlatformConnectionsService, PlatformConnection } from '../platform-connections/platform-connections.service';

// Define the shape of the state JWT payload

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
    private readonly platformConnectionsService: PlatformConnectionsService, // Injected PlatformConnectionsService
  ) {
    this.jwtSecret = this.configService.get<string>('JWT_SECRET')!;
    if (!this.jwtSecret) {
      throw new Error('JWT_SECRET environment variable is not set');
    }
  }

  async exchangeClerkTokenForSupabase(clerkToken: string): Promise<{ supabase_token: string; expires_in: number }> {
    const issuer = this.configService.get<string>('CLERK_ISSUER');
    const audience = this.configService.get<string>('CLERK_AUDIENCE'); // optional
    const supabaseJwtSecret = this.configService.get<string>('SUPABASE_JWT_SECRET');
    if (!supabaseJwtSecret) {
      throw new InternalServerErrorException('SUPABASE_JWT_SECRET not configured');
    }

    // Unverified decode for diagnostics (alg, kid, iss, aud)
    let headerAlg: string | undefined;
    let headerKid: string | undefined;
    let unverifiedIss: string | undefined;
    let unverifiedAud: string | undefined;
    try {
      const [h, p] = clerkToken.split('.');
      const headerJson = Buffer.from(h.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      const payloadJson = Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      const header = JSON.parse(headerJson);
      const unverifiedPayload = JSON.parse(payloadJson);
      headerAlg = header.alg as string | undefined;
      headerKid = header.kid as string | undefined;
      unverifiedIss = unverifiedPayload.iss as string | undefined;
      unverifiedAud = unverifiedPayload.aud as string | undefined;
    } catch {}
    this.logger.debug(`[Auth.exchange] incoming token alg=${headerAlg} kid=${headerKid} iss=${unverifiedIss} aud=${unverifiedAud}`);
    this.logger.debug(`[Auth.exchange] configured issuer=${issuer} audience=${audience}`);

    let payload: Record<string, any>;
    if (headerAlg && headerAlg.toUpperCase().startsWith('HS')) {
      const hsSecret = this.configService.get<string>('CLERK_JWT_HS_SECRET');
      if (!hsSecret) {
        this.logger.error('HS256 Clerk token received but CLERK_JWT_HS_SECRET is not configured.');
        throw new UnauthorizedException('HS256 token received but server configured for RS256');
      }
      try {
        payload = jwt.verify(clerkToken, hsSecret, {
          algorithms: [headerAlg as any],
          issuer: issuer || undefined,
          audience: audience || undefined,
        }) as Record<string, any>;
      } catch (e: any) {
        this.logger.error(`HS Clerk token verification failed: ${e?.message || e}`);
        throw new UnauthorizedException('Invalid Clerk session token');
      }
    } else {
      const jwksUrl = this.configService.get<string>('CLERK_JWKS_URL') || 'https://YOUR-CLERK-DOMAIN/.well-known/jwks.json';
      if (!jwksUrl || jwksUrl.includes('YOUR-CLERK-DOMAIN')) {
        this.logger.error('CLERK_JWKS_URL is not configured correctly. Set it to your Clerk domain JWKS endpoint.');
        throw new InternalServerErrorException('Server misconfiguration: CLERK_JWKS_URL not set');
      }
      this.logger.debug(`[Auth.exchange] Verifying RS token using JWKS: ${jwksUrl}`);
      try {
        // Manually fetch JWKS and verify using jsonwebtoken with PEM
        const res = await axios.get(jwksUrl, { timeout: 5000 });
        const keys = res.data?.keys as Array<any> | undefined;
        if (!keys || keys.length === 0) throw new Error('No JWKS keys');
        // Decode header to get kid
        const headerB64 = clerkToken.split('.')[0];
        const headerJson = Buffer.from(headerB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        const kid = JSON.parse(headerJson)?.kid;
        const jwk = (kid ? keys.find(k => k.kid === kid) : keys[0]) || keys[0];
        if (!jwk) throw new Error('Matching JWK not found');
        this.logger.debug(`[Auth.exchange] Selected JWK kid=${jwk.kid} kty=${jwk.kty} alg=${jwk.alg}`);
        const pem = jwkToPem(jwk);
        payload = jwt.verify(clerkToken, pem, {
          algorithms: ['RS256', 'RS512', 'ES256', 'ES384'],
          issuer: issuer || undefined,
          audience: audience || undefined,
        }) as Record<string, any>;
      } catch (e: any) {
        this.logger.error(`Clerk token verification (JWKS) failed: ${e?.message || e}`);
        throw new UnauthorizedException('Invalid Clerk session token');
      }
    }

    const clerkUserId = payload.sub as string;
    const email = (payload['email'] as string) || '';

    // Find or create a Users row so we can use its UUID as JWT sub
    const sb = this.supabaseService.getServiceClient();
    let userId: string | null = null;

    if (!email) {
      // For minimal setup we require email to link users; configure Clerk to include email in session token
      throw new InternalServerErrorException('Clerk token missing email claim. Enable email in Clerk session token.');
    }

    // Try to find existing user by email
    const { data: existing, error: findErr } = await sb
      .from('Users')
      .select('Id, Email')
      .eq('Email', email)
      .maybeSingle();
    if (findErr) {
      throw new InternalServerErrorException(`Supabase query error: ${findErr.message}`);
    }
    if (existing?.Id) {
      userId = existing.Id as string;
    } else {
      // Create
      const { data: inserted, error: insertErr } = await sb
        .from('Users')
        .insert({ Email: email })
        .select('Id')
        .single();
      if (insertErr || !inserted?.Id) {
        throw new InternalServerErrorException(`Failed to create user: ${insertErr?.message || 'unknown error'}`);
      }
      userId = inserted.Id as string;
    }

    // Minimal claim set for Supabase RLS. Keep short-lived.
    const expiresInSeconds = 600; // 10m
    const supabaseToken = jwt.sign(
      {
        sub: userId, // UUID from our Users table
        role: 'authenticated',
        email,
      },
      supabaseJwtSecret,
      { algorithm: 'HS256', expiresIn: expiresInSeconds }
    );

    return { supabase_token: supabaseToken, expires_in: expiresInSeconds };
  }

  // --- Clerk webhook handling (basic user/org mirror) ---
  async handleClerkWebhook(event: any): Promise<{ ok: true }> {
    const type = event?.type as string | undefined;
    const data = event?.data;
    const sb = this.supabaseService.getServiceClient();
    if (!type || !data) return { ok: true };

    if (type === 'user.created' || type === 'user.updated') {
      const email = data?.primary_email_address?.email_address || data?.email_addresses?.[0]?.email_address;
      if (email) {
        // Upsert Users by Email
        await sb.from('Users').upsert({ Email: email }, { onConflict: 'Email' });
      }
      return { ok: true };
    }

    // TODO: Add organization and membership mirror when you enable Clerk Orgs
    // e.g., organization.created, organizationMembership.created, ... map to Supabase tables

    return { ok: true };
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

      // Use PlatformConnectionsService to create or update the connection
      await this.platformConnectionsService.createOrUpdateConnection(
        statePayload.userId,
        'shopify',
        shop, // DisplayName will be the shop domain
        { accessToken: tokenData.access_token }, // rawCredentials
        'active', // Status - if it's an update, it becomes active. If new, createOrUpdateConnection makes it 'pending'. Let's make it active on successful auth.
        { shop: shop }, // platformSpecificData
      );

      this.logger.log(`Platform connection processing complete for Shopify shop: ${shop}, userId: ${statePayload.userId}`);
  

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


      await this.platformConnectionsService.createOrUpdateConnection(
        userIdFromState,
        'clover',
        displayName,
        credentials,
        'needs_review', // Or 'syncing' if you auto-start scan
        { merchantId: merchantId },
      );

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

  // --- eBay ---
  getEbayAuthUrl(userId: string, finalRedirectUri: string): string {
    const clientId = this.configService.get<string>('EBAY_CLIENT_ID');
    const redirectUri = this.configService.get<string>('EBAY_REDIRECT_URI');
    const scopes = this.configService.get<string>('EBAY_SCOPES');
    const authBase = this.configService.get<string>('EBAY_AUTH_BASE_URL', 'https://auth.sandbox.ebay.com');
    if (!clientId || !redirectUri || !scopes) {
      throw new InternalServerErrorException('eBay OAuth not configured.');
    }
    const state = this.generateStateJwt({ userId, platform: 'ebay', finalRedirectUri });
    const url = new URL('/oauth2/authorize', authBase);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', scopes);
    url.searchParams.set('state', state);
    return url.toString();
  }

  async handleEbayCallback(code: string, state: string): Promise<void> {
    const payload = this.verifyStateJwt(state, 'ebay');
    const clientId = this.configService.get<string>('EBAY_CLIENT_ID');
    const clientSecret = this.configService.get<string>('EBAY_CLIENT_SECRET');
    const redirectUri = this.configService.get<string>('EBAY_REDIRECT_URI');
    const apiBase = this.configService.get<string>('EBAY_API_BASE_URL', 'https://api.sandbox.ebay.com');
    if (!clientId || !clientSecret || !redirectUri) throw new InternalServerErrorException('eBay OAuth not configured.');

    // Exchange code for refresh_token
    const tokenUrl = new URL('/identity/v1/oauth2/token', apiBase);
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const body = new URLSearchParams();
    body.set('grant_type', 'authorization_code');
    body.set('code', code);
    body.set('redirect_uri', redirectUri);

    const resp = await fetch(tokenUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${basic}` },
      body: body.toString(),
    });
    if (!resp.ok) {
      const t = await resp.text();
      this.logger.error(`eBay token exchange failed: ${resp.status} ${t}`);
      throw new InternalServerErrorException('Failed to exchange eBay code.');
    }
    const tokenData = await resp.json();
    const refreshToken = tokenData.refresh_token;
    if (!refreshToken) throw new InternalServerErrorException('eBay response missing refresh_token.');

    // Optional: get identity to derive account id/name
    let accountId = 'ebay-account';
    try {
      const accessToken = tokenData.access_token;
      if (accessToken) {
        const idResp = await fetch(new URL('/identity/v1/oauth2/user/', apiBase).toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
        if (idResp.ok) {
          const idBody = await idResp.json();
          accountId = idBody?.userId || accountId;
        }
      }
    } catch {}

    await this.platformConnectionsService.createOrUpdateConnection(
      payload.userId,
      'ebay',
      `eBay (${accountId})`,
      { refreshToken },
      'active',
      { accountId },
    );
  }

  // --- Facebook ---
  getFacebookAuthUrl(userId: string, finalRedirectUri: string): string {
    const appId = this.configService.get<string>('FB_APP_ID');
    const redirectUri = this.configService.get<string>('FB_REDIRECT_URI');
    const scopes = this.configService.get<string>('FB_SCOPES');
    const version = this.configService.get<string>('FB_GRAPH_API_VERSION', 'v19.0');
    if (!appId || !redirectUri || !scopes) throw new InternalServerErrorException('Facebook OAuth not configured.');
    const state = this.generateStateJwt({ userId, platform: 'facebook', finalRedirectUri });
    const url = new URL(`https://www.facebook.com/${version}/dialog/oauth`);
    url.searchParams.set('client_id', appId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', scopes);
    url.searchParams.set('state', state);
    return url.toString();
  }

  async handleFacebookCallback(code: string, state: string): Promise<void> {
    const payload = this.verifyStateJwt(state, 'facebook');
    const appId = this.configService.get<string>('FB_APP_ID');
    const appSecret = this.configService.get<string>('FB_APP_SECRET');
    const redirectUri = this.configService.get<string>('FB_REDIRECT_URI');
    const version = this.configService.get<string>('FB_GRAPH_API_VERSION', 'v19.0');
    if (!appId || !appSecret || !redirectUri) throw new InternalServerErrorException('Facebook OAuth not configured.');

    // Exchange code for user access token
    const tokenUrl = new URL(`https://graph.facebook.com/${version}/oauth/access_token`);
    tokenUrl.searchParams.set('client_id', appId);
    tokenUrl.searchParams.set('client_secret', appSecret);
    tokenUrl.searchParams.set('redirect_uri', redirectUri);
    tokenUrl.searchParams.set('code', code);

    const resp = await fetch(tokenUrl.toString());
    if (!resp.ok) {
      const t = await resp.text();
      this.logger.error(`Facebook token exchange failed: ${resp.status} ${t}`);
      throw new InternalServerErrorException('Failed to exchange Facebook code.');
    }
    const tokenData = await resp.json();
    const userAccessToken = tokenData.access_token;
    if (!userAccessToken) throw new InternalServerErrorException('Facebook response missing access_token');

    // Optional: exchange for long-lived token
    let longLived = userAccessToken;
    try {
      const extUrl = new URL(`https://graph.facebook.com/${version}/oauth/access_token`);
      extUrl.searchParams.set('grant_type', 'fb_exchange_token');
      extUrl.searchParams.set('client_id', appId);
      extUrl.searchParams.set('client_secret', appSecret);
      extUrl.searchParams.set('fb_exchange_token', userAccessToken);
      const extResp = await fetch(extUrl.toString());
      if (extResp.ok) {
        const extData = await extResp.json();
        longLived = extData.access_token || userAccessToken;
      }
    } catch {}

    // Fetch pages and pick first (phase 1)
    let pageId = undefined;
    let pageName = 'Facebook Page';
    try {
      const pagesResp = await fetch(`https://graph.facebook.com/${version}/me/accounts`, { headers: { Authorization: `Bearer ${longLived}` } });
      if (pagesResp.ok) {
        const pages = await pagesResp.json();
        const first = pages.data?.[0];
        if (first) {
          pageId = first.id;
          pageName = first.name || pageName;
        }
      }
    } catch {}

    await this.platformConnectionsService.createOrUpdateConnection(
      payload.userId,
      'facebook',
      pageName,
      { userAccessTokenLL: longLived, pageId },
      'active',
      { pageId },
    );
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

      await this.platformConnectionsService.createOrUpdateConnection(
        statePayload.userId,
        'square',
        `Square (${tokenData.merchant_id || 'Account'})`,
        {
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token,
          expiresAt: tokenData.expires_at,
        },
        'active',
        { merchantId: tokenData.merchant_id },
      );
      this.logger.log(`Platform connection saved/updated for Square merchant: ${tokenData.merchant_id}, userId: ${statePayload.userId}`);

    } catch (error) {
      this.logger.error(`Error handling Square callback: ${error.message}`, error.stack);
      throw error;
    }
  }
}
