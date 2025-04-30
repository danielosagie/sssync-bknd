import { Injectable, Logger, OnModuleInit, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseService implements OnModuleInit {
  private readonly logger = new Logger(SupabaseService.name);
  private _supabase?: SupabaseClient;

  constructor(private configService: ConfigService) {
    this.logger.log('SupabaseService Constructor called.');
  }

  onModuleInit() {
    this.logger.log('SupabaseService onModuleInit - Initializing client...');
    const supabaseUrl = this.configService.get<string>('SUPABASE_URL');
    const supabaseAnonKey = this.configService.get<string>('SUPABASE_ANON_KEY');

    if (!supabaseUrl || !supabaseAnonKey) {
      this.logger.error('SUPABASE_URL or SUPABASE_ANON_KEY missing in config! Supabase client NOT initialized.');
      return;
    }

    try {
      this._supabase = createClient(supabaseUrl, supabaseAnonKey);
      this.logger.log('Supabase client initialized successfully in onModuleInit.');
    } catch (error) {
      this.logger.error(`Failed to initialize Supabase client: ${error.message}`, error.stack);
      throw new InternalServerErrorException(`Failed to initialize Supabase client: ${error.message}`);
    }
  }

  getClient(): SupabaseClient {
    if (!this._supabase) {
      this.logger.error('Attempted to get Supabase client before it was initialized or initialization failed!');
      throw new InternalServerErrorException('Supabase client is not available. Initialization might have failed or is pending.');
    }
    return this._supabase;
  }
}
