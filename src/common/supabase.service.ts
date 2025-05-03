import { Injectable, Logger, OnModuleInit, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseService implements OnModuleInit {
  private readonly logger = new Logger(SupabaseService.name);
  private _supabase?: SupabaseClient; // Client with anon key - subject to RLS
  private _supabaseService?: SupabaseClient; // Client with service_role key - bypasses RLS

  constructor(private configService: ConfigService) {
    this.logger.log('SupabaseService Constructor called.');
  }

  onModuleInit() {
    this.logger.log('SupabaseService onModuleInit - Initializing clients...');
    const supabaseUrl = this.configService.get<string>('SUPABASE_URL');
    const supabaseAnonKey = this.configService.get<string>('SUPABASE_ANON_KEY');
    const supabaseServiceKey = this.configService.get<string>('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseAnonKey) {
      this.logger.error('SUPABASE_URL or SUPABASE_ANON_KEY missing in config! Supabase client NOT initialized.');
      return;
    }

    try {
      // Initialize regular client with anon key (subject to RLS)
      this._supabase = createClient(supabaseUrl, supabaseAnonKey);
      this.logger.log('Supabase client (anon key) initialized successfully.');
      
      // Initialize service client with service_role key (bypasses RLS)
      if (supabaseServiceKey) {
        this._supabaseService = createClient(supabaseUrl, supabaseServiceKey);
        this.logger.log('Supabase service client (service_role key) initialized successfully.');
      } else {
        this.logger.warn('SUPABASE_SERVICE_ROLE_KEY missing in config! Backend operations may be subject to RLS restrictions.');
      }
    } catch (error) {
      this.logger.error(`Failed to initialize Supabase clients: ${error.message}`, error.stack);
      throw new InternalServerErrorException(`Failed to initialize Supabase clients: ${error.message}`);
    }
  }

  // Get regular client (for frontend user operations - RLS applies)
  getClient(): SupabaseClient {
    if (!this._supabase) {
      this.logger.error('Attempted to get Supabase client before it was initialized or initialization failed!');
      throw new InternalServerErrorException('Supabase client is not available. Initialization might have failed or is pending.');
    }
    return this._supabase;
  }

  // Get service client (for backend operations - bypasses RLS)
  getServiceClient(): SupabaseClient {
    if (!this._supabaseService) {
      this.logger.warn('Service role client not available. Falling back to anon client which is subject to RLS!');
      return this.getClient(); // Fall back to regular client if service client not initialized
    }
    return this._supabaseService;
  }
}
