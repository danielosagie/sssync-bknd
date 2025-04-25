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
  private supabase: SupabaseClient;
  private readonly logger = new Logger(AuthService.name); // Initialize logger
  private readonly jwtSecret: string;
  private readonly stateTokenExpiry: string = '5m'; // Example expiry for state token

  constructor(
    private readonly configService: ConfigService,
    private readonly supabaseService: SupabaseService,
    private readonly encryptionService: EncryptionService,
    private readonly jwtService: JwtService, // Inject JwtService
  ) {
    this.supabase = this.supabaseService.getClient();
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
    const { data, error } = await this.supabase
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

  getShopifyAuthUrl(shop: string, userId: string, finalRedirectUri: string): string {
    const apiKey = this.configService.get<string>('SHOPIFY_API_KEY');
    const scopes = this.configService.get<string>('SHOPIFY_SCOPES');
    const redirectUri = this.configService.get<string>('SHOPIFY_REDIRECT_URI');

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

    const authUrl = new URL(`https://${shop}.myshopify.com/admin/oauth/authorize`);
    authUrl.hostname = `${shop}.myshopify.com`;
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

      if (statePayload.shop !== shop) {
        throw new BadRequestException(`State shop parameter mismatch. Expected ${statePayload.shop}, received ${shop}`);
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

      const credentialsToStore = {
        accessToken: tokenData.access_token,
      };

      await this.savePlatformConnection({
        UserId: statePayload.userId,
        PlatformType: 'shopify',
        DisplayName: shop,
        Credentials: credentialsToStore,
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

  getCloverAuthUrl(userId: string, finalRedirectUri: string): string {
    const appId = this.configService.get<string>('CLOVER_APP_ID');
    const redirectUri = this.configService.get<string>('CLOVER_REDIRECT_URI');
    const cloverBaseUrl = this.configService.get<string>('CLOVER_API_BASE_URL'); // e.g., https://clover.com or https://sandbox.dev.clover.com

    if (!appId || !redirectUri || !cloverBaseUrl) {
      throw new InternalServerErrorException('Clover configuration is missing or invalid.');
    }

    const statePayload: Omit<StatePayload, 'nonce'> = {
      userId,
      platform: 'clover',
      finalRedirectUri,
    };
    const state = this.generateStateJwt(statePayload);

    const authUrl = new URL('/oauth/authorize', cloverBaseUrl);
    authUrl.searchParams.set('client_id', appId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);

    return authUrl.toString();
  }

  async handleCloverCallback(code: string, merchantId: string, state: string): Promise<void> {
    this.logger.log(`Handling Clover callback for merchantId: ${merchantId}`);
    let statePayload: StatePayload;
    try {
      statePayload = this.verifyStateJwt(state, 'clover');
      this.logger.debug(`State verified for merchant: ${merchantId}, userId: ${statePayload.userId}`);

      const appId = this.configService.get<string>('CLOVER_APP_ID');
      const appSecret = this.configService.get<string>('CLOVER_APP_SECRET');
      const cloverBaseUrl = this.configService.get<string>('CLOVER_API_BASE_URL');
      if (!appId || !appSecret) throw new InternalServerErrorException('Clover configuration error.');

      const tokenUrl = new URL('/oauth/token', cloverBaseUrl);
      const params = new URLSearchParams();
      params.set('client_id', appId);
      params.set('client_secret', appSecret);
      params.set('code', code);

      const response = await fetch(tokenUrl.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        this.logger.error(`Clover token exchange failed for merchant ${merchantId}. Status: ${response.status}. Body: ${errorBody}`);
        throw new InternalServerErrorException(`Failed to exchange Clover code for token. Status: ${response.status}`);
      }
      const tokenData = await response.json();
      if (!tokenData.access_token) {
        this.logger.error(`Clover token exchange response missing access_token for merchant ${merchantId}. Response: ${JSON.stringify(tokenData)}`);
        throw new InternalServerErrorException('Invalid token response from Clover.');
      }
      this.logger.log(`Successfully obtained Clover access token for merchant: ${merchantId}`);

      const credentialsToStore = {
        accessToken: tokenData.access_token,
      };

      await this.savePlatformConnection({
        UserId: statePayload.userId,
        PlatformType: 'clover',
        DisplayName: `Clover (${merchantId})`,
        Credentials: credentialsToStore,
        Status: 'Connected',
        IsEnabled: true,
        PlatformSpecificData: { merchantId: merchantId },
      });
      this.logger.log(`Platform connection saved/updated for Clover merchant: ${merchantId}, userId: ${statePayload.userId}`);

    } catch (error) {
      this.logger.error(`Error handling Clover callback for merchant ${merchantId}: ${error.message}`, error.stack);
      throw error;
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

      const credentialsToStore = {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt: tokenData.expires_at,
      };

      await this.savePlatformConnection({
        UserId: statePayload.userId,
        PlatformType: 'square',
        DisplayName: `Square (${tokenData.merchant_id || 'Account'})`,
        Credentials: credentialsToStore,
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
