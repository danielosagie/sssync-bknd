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

// Define the shape of the state JWT payload
interface StatePayload {
  userId: string;
  platform: 'shopify' | 'clover' | 'square';
  nonce: string; // Add nonce for extra security against replay attacks
  // Include platform-specific data needed during callback if necessary
  shop?: string; // For Shopify
}

// Define the shape of the PlatformConnection data for Supabase
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

  constructor(
    private readonly configService: ConfigService,
    private readonly supabaseService: SupabaseService,
    private readonly encryptionService: EncryptionService,
    private readonly jwtService: JwtService, // Inject JwtService
  ) {
    this.supabase = this.supabaseService.getClient();
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
   * Verifies the state JWT received during callback.
   * @throws BadRequestException if JWT is invalid, expired, or platform mismatch.
   */
  private verifyStateJwt(stateJwt: string, expectedPlatform: StatePayload['platform']): StatePayload {
    try {
      const payload = this.jwtService.verify<StatePayload>(stateJwt);
      if (payload.platform !== expectedPlatform) {
        throw new Error('Platform mismatch in state');
      }
      return payload;
    } catch (error) {
      this.logger.error(`State JWT verification failed: ${error.message}`, error.stack);
      throw new BadRequestException(`Invalid or expired state parameter: ${error.message}`);
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

  getShopifyAuthUrl(shop: string, userId: string): string {
    const apiKey = this.configService.get<string>('SHOPIFY_API_KEY');
    const scopes = this.configService.get<string>('SHOPIFY_SCOPES');
    const redirectUri = this.configService.get<string>('SHOPIFY_REDIRECT_URI');

    if (!apiKey || !scopes || !redirectUri || !shop) {
      throw new InternalServerErrorException('Shopify configuration is missing or invalid.');
    }

    // Pass shop domain in state for potential use during callback verification
    const state = this.generateStateJwt({ userId, platform: 'shopify', shop });

    const authUrl = `https://${shop}/admin/oauth/authorize?client_id=${apiKey}&scope=${scopes}&redirect_uri=${redirectUri}&state=${state}`;
    this.logger.log(`Generated Shopify Auth URL for user ${userId}, shop ${shop}`);
    return authUrl;
  }

  async handleShopifyCallback(code: string, shop: string, state: string) {
    // 1. Verify State JWT
    const statePayload = this.verifyStateJwt(state, 'shopify');
    // Optional: Double-check shop if needed, though HMAC verification is primary
    if (statePayload.shop !== shop) {
        this.logger.warn(`Shop mismatch in state JWT vs callback param: ${statePayload.shop} vs ${shop}`);
        // Decide whether to throw or just log based on security posture
        // throw new BadRequestException('Shop parameter mismatch.');
    }
    const userId = statePayload.userId;
    this.logger.log(`Handling Shopify callback for user ${userId}, shop ${shop}`);

    // 2. Exchange Code for Token
    const apiKey = this.configService.get<string>('SHOPIFY_API_KEY');
    const apiSecret = this.configService.get<string>('SHOPIFY_API_SECRET');
    const tokenUrl = `https://${shop}/admin/oauth/access_token`;

    if (!apiKey || !apiSecret) {
      throw new InternalServerErrorException('Shopify API credentials missing.');
    }

    let accessToken: string;
    try {
      const response = await axios.post<{ access_token: string }>(tokenUrl, {
        client_id: apiKey,
        client_secret: apiSecret,
        code,
      });
      accessToken = response.data.access_token;
      if (!accessToken) {
        throw new Error('Access token not found in Shopify response');
      }
      this.logger.log(`Successfully exchanged code for Shopify token for user ${userId}`);
    } catch (error) {
      this.logger.error(
        `Shopify token exchange failed for user ${userId}: ${error.response?.data?.error_description || error.message}`,
        error.stack,
      );
      throw new InternalServerErrorException('Failed to exchange Shopify code for access token.');
    }

    // 3. Prepare and Save Connection
    const credentialsToSave = { accessToken, shop }; // Store shop domain for context
    return this.savePlatformConnection({
      UserId: userId,
      PlatformType: 'Shopify',
      DisplayName: shop,
      Credentials: credentialsToSave,
      Status: 'Connected',
      IsEnabled: true,
    });
  }

  // --- Clover ---

  getCloverAuthUrl(userId: string): string {
    const appId = this.configService.get<string>('CLOVER_APP_ID');
    const redirectUri = this.configService.get<string>('CLOVER_REDIRECT_URI');
    const cloverBaseUrl = this.configService.get<string>('CLOVER_API_BASE_URL'); // e.g., https://clover.com or https://sandbox.dev.clover.com

    if (!appId || !redirectUri || !cloverBaseUrl) {
      throw new InternalServerErrorException('Clover configuration is missing or invalid.');
    }

    const state = this.generateStateJwt({ userId, platform: 'clover' });

    // Clover uses /oauth/authorize path
    const authUrl = `${cloverBaseUrl}/oauth/authorize?client_id=${appId}&redirect_uri=${redirectUri}&state=${state}&response_type=code`;
    // Add &force_login=true if you want to force user login each time
    this.logger.log(`Generated Clover Auth URL for user ${userId}`);
    return authUrl;
  }

  async handleCloverCallback(code: string, merchantId: string, state: string) {
    // 1. Verify State JWT
    const statePayload = this.verifyStateJwt(state, 'clover');
    const userId = statePayload.userId;
    this.logger.log(`Handling Clover callback for user ${userId}, merchant ${merchantId}`);

    if (!merchantId) {
        throw new BadRequestException('Missing merchant_id parameter from Clover callback.');
    }

    // 2. Exchange Code for Token
    const appId = this.configService.get<string>('CLOVER_APP_ID');
    const appSecret = this.configService.get<string>('CLOVER_APP_SECRET');
    const redirectUri = this.configService.get<string>('CLOVER_REDIRECT_URI');
    const cloverBaseUrl = this.configService.get<string>('CLOVER_API_BASE_URL');
    const tokenUrl = `${cloverBaseUrl}/oauth/token`;

    if (!appId || !appSecret || !redirectUri) {
      throw new InternalServerErrorException('Clover API credentials missing.');
    }

    let accessToken: string;
    try {
      // Clover token exchange requires client_id, client_secret, code, grant_type
      const response = await axios.post<{ access_token: string }>(tokenUrl, null, { // POST with query params
        params: {
          client_id: appId,
          client_secret: appSecret,
          code,
          grant_type: 'authorization_code',
          // redirect_uri: redirectUri // Redirect URI is sometimes required by OAuth2 spec, check Clover docs
        }
      });

      accessToken = response.data.access_token;
      if (!accessToken) {
        throw new Error('Access token not found in Clover response');
      }
      this.logger.log(`Successfully exchanged code for Clover token for user ${userId}`);
    } catch (error) {
      this.logger.error(
        `Clover token exchange failed for user ${userId}: ${error.response?.data?.message || error.message}`,
        error.stack,
      );
      throw new InternalServerErrorException('Failed to exchange Clover code for access token.');
    }

    // 3. Prepare and Save Connection
    // Store merchant ID along with token
    const credentialsToSave = { accessToken, merchantId };
    // Use merchant ID or fetch merchant name as DisplayName if desired/possible
    return this.savePlatformConnection({
      UserId: userId,
      PlatformType: 'Clover',
      DisplayName: `Clover (${merchantId})`, // Example display name
      Credentials: credentialsToSave,
      PlatformSpecificData: { merchantId }, // Store merchantId separately if needed for queries
      Status: 'Connected',
      IsEnabled: true,
    });
  }

  // --- Square ---

  getSquareAuthUrl(userId: string): string {
    const appId = this.configService.get<string>('SQUARE_APP_ID');
    const redirectUri = this.configService.get<string>('SQUARE_REDIRECT_URI');
    const scopes = this.configService.get<string>('SQUARE_SCOPES');
    const squareAuthBaseUrl = 'https://connect.squareup.com'; // Use Square's production base URL

    if (!appId || !redirectUri || !scopes) {
      throw new InternalServerErrorException('Square configuration is missing or invalid.');
    }

    const state = this.generateStateJwt({ userId, platform: 'square' });

    // Square uses /oauth2/authorize
    // 'session=false' forces login screen, 'session=true' tries to reuse existing session
    const authUrl = `${squareAuthBaseUrl}/oauth2/authorize?client_id=${appId}&response_type=code&scope=${scopes.replace(/,/g, '+')}&redirect_uri=${redirectUri}&state=${state}&session=false`;
    this.logger.log(`Generated Square Auth URL for user ${userId}`);
    return authUrl;
  }

  async handleSquareCallback(code: string, state: string) {
    // 1. Verify State JWT
    const statePayload = this.verifyStateJwt(state, 'square');
    const userId = statePayload.userId;
    this.logger.log(`Handling Square callback for user ${userId}`);

    // 2. Exchange Code for Token
    const appId = this.configService.get<string>('SQUARE_APP_ID');
    const appSecret = this.configService.get<string>('SQUARE_APP_SECRET');
    const redirectUri = this.configService.get<string>('SQUARE_REDIRECT_URI');
    const squareTokenUrl = 'https://connect.squareup.com/oauth2/token';

    if (!appId || !appSecret || !redirectUri) {
      throw new InternalServerErrorException('Square API credentials missing.');
    }

    let tokenData: {
        access_token: string;
        refresh_token: string;
        expires_at: string;
        merchant_id: string;
        token_type: string;
    };
    try {
      const response = await axios.post<typeof tokenData>(squareTokenUrl, {
        client_id: appId,
        client_secret: appSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        // Square sometimes requires scopes in token request too
        scopes: this.configService.get<string>('SQUARE_SCOPES')?.split(','),
      });

      tokenData = response.data;
      if (!tokenData.access_token || !tokenData.merchant_id) {
        throw new Error('Access token or merchant_id not found in Square response');
      }
      this.logger.log(`Successfully exchanged code for Square token for user ${userId}`);
    } catch (error) {
        const errorMessage = error.response?.data?.errors?.[0]?.detail || error.response?.data?.message || error.message;
      this.logger.error(
        `Square token exchange failed for user ${userId}: ${errorMessage}`,
        error.stack,
      );
      throw new InternalServerErrorException('Failed to exchange Square code for access token.');
    }

    // 3. Prepare and Save Connection
    const credentialsToSave = {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt: tokenData.expires_at,
        merchantId: tokenData.merchant_id,
    };
    // Use Merchant ID or fetch Merchant name as DisplayName
    return this.savePlatformConnection({
      UserId: userId,
      PlatformType: 'Square',
      DisplayName: `Square (${tokenData.merchant_id})`,
      Credentials: credentialsToSave,
      PlatformSpecificData: { merchantId: tokenData.merchant_id },
      Status: 'Connected',
      IsEnabled: true,
    });
  }
}
