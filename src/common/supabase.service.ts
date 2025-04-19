import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseService implements OnModuleInit {
  private supabase: SupabaseClient;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const supabaseUrl = this.configService.get<string>('SUPABASE_URL');
    const supabaseAnonKey = this.configService.get<string>('SUPABASE_ANON_KEY');

    if (!supabaseUrl || !supabaseAnonKey) {
      throw new Error('Supabase URL and Anon Key must be provided in environment variables.');
    }

    this.supabase = createClient(supabaseUrl, supabaseAnonKey, {
      // Optional: Configure Supabase client options here
      // auth: {
      //   persistSession: false // Example: Disable session persistence if managing tokens server-side
      // }
    });

    console.log('Supabase client initialized.');
  }

  getClient(): SupabaseClient {
    return this.supabase;
  }
}
