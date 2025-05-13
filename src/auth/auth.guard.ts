import { Injectable } from '@nestjs/common';
import { AuthGuard as PassportAuthGuard } from '@nestjs/passport';
import { SupabaseAuthGuard } from './guards/supabase-auth.guard';

@Injectable()
export class AuthGuard extends SupabaseAuthGuard {} 