import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseService {
  private readonly logger = new Logger(SupabaseService.name);
  private _supabase?: SupabaseClient;
  private _supabaseService?: SupabaseClient;
  private initializationPromise: Promise<void> | null = null;

  constructor(private configService: ConfigService) {
    this.logger.log('SupabaseService Constructor called.');
  }

  async initialize(): Promise<void> {
    // Prevent re-initialization if called multiple times, though factory should only call once.
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = (async () => {
      this.logger.log('SupabaseService initialize() - Initializing clients...');
      const supabaseUrl = this.configService.get<string>('SUPABASE_URL');
      const supabaseAnonKey = this.configService.get<string>('SUPABASE_ANON_KEY');
      const supabaseServiceKey = this.configService.get<string>('SUPABASE_SERVICE_ROLE_KEY');

      if (!supabaseUrl || !supabaseAnonKey) {
        this.logger.error('SUPABASE_URL or SUPABASE_ANON_KEY missing in config! Supabase client NOT initialized.');
        throw new InternalServerErrorException('Supabase config missing for client initialization.');
      }

      try {
        this._supabase = createClient(supabaseUrl, supabaseAnonKey);
        this.logger.log('Supabase client (anon key) initialized successfully.');
        
        if (supabaseServiceKey) {
          this._supabaseService = createClient(supabaseUrl, supabaseServiceKey);
          this.logger.log('Supabase service client (service_role key) initialized successfully.');
        } else {
          this.logger.warn('SUPABASE_SERVICE_ROLE_KEY missing in config! Service client not fully initialized. Operations requiring service_role key may fail or be subject to RLS.');
        }
        this.logger.log('SupabaseService initialize() - Client initialization finished.');
      } catch (error) {
        this.logger.error(`Failed to initialize Supabase clients: ${error.message}`, error.stack);
        // Ensure the promise rejects on error so the factory awaits properly.
        throw new InternalServerErrorException(`Failed to initialize Supabase clients: ${error.message}`);
      }
    })();
    
    return this.initializationPromise;
  }

  getClient(): SupabaseClient {
    if (!this._supabase) {
      this.logger.error('Attempted to get Supabase client, but it is not initialized. This may indicate an issue with the async provider setup.');
      throw new InternalServerErrorException('Supabase client is not available. Initialization might have failed or is not complete.');
    }
    return this._supabase;
  }

  getServiceClient(): SupabaseClient {
    if (!this._supabaseService) {
      this.logger.warn('Service role client not available. Falling back to anon client which is subject to RLS!');
      // Fallback to regular client if service client not initialized
      if(!this._supabase) {
        this.logger.error('Attempted to get Supabase service client (or fallback), but no clients are initialized. This indicates a critical issue with the async provider setup.');
        throw new InternalServerErrorException('Supabase clients are not available. Initialization might have failed or is not complete.');
      }
      return this._supabase; 
    }
    return this._supabaseService;
  }

  /**
   * Creates an authenticated Supabase client with the user's JWT token
   * This is essential for RLS to work correctly with Clerk/Supabase exchange
   */
  getAuthenticatedClient(userJwtToken: string): SupabaseClient {
    const supabaseUrl = this.configService.get<string>('SUPABASE_URL');
    const supabaseAnonKey = this.configService.get<string>('SUPABASE_ANON_KEY');

    if (!supabaseUrl || !supabaseAnonKey) {
      throw new InternalServerErrorException('Supabase config missing for authenticated client creation.');
    }

    // Create a new client instance with the user's token
    const authenticatedClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: {
          Authorization: `Bearer ${userJwtToken}`,
        },
      },
    });

    return authenticatedClient;
  }
}
