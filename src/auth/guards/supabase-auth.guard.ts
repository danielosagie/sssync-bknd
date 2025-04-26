import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
  Inject, // Use Inject if SupabaseService is not globally provided/exported correctly
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase.service'; // Adjust path as needed
import { Request } from 'express';

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  private readonly logger = new Logger(SupabaseAuthGuard.name);

  // Inject SupabaseService - ensure it's available globally or exported
  // from the module where it's provided (e.g., AppModule)
  constructor(
    private readonly supabaseService: SupabaseService
    // Alternatively, if DI issues persist, inject SupabaseClient directly
    // @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractTokenFromHeader(request);

    if (!token) {
      this.logger.warn('No JWT token found in Authorization header');
      throw new UnauthorizedException('Authorization token is required');
    }

    try {
      const supabase = this.supabaseService.getClient(); // Get the initialized client

      // Validate the token using Supabase client's auth helper
      // This checks signature, expiry, etc. against Supabase Auth settings
      const { data: { user }, error } = await supabase.auth.getUser(token);

      if (error) {
        this.logger.warn(`Token validation failed: ${error.message}`);
        // Map common Supabase auth errors to appropriate responses
        if (error.message === 'invalid JWT' || error.message.includes('expired')) {
           throw new UnauthorizedException('Invalid or expired token');
        }
        // For other errors, maybe log more details but return a generic unauthorized
        throw new UnauthorizedException('Authentication failed');
      }

      if (!user) {
         // Should ideally be caught by the error above, but double-check
         this.logger.warn('Token validated but no user object returned.');
         throw new UnauthorizedException('Authentication failed');
      }

      // IMPORTANT: Attach the user object (or at least relevant parts like id) to the request
      // This makes it available downstream (e.g., in controllers, other guards like FeatureUsageGuard)
      // Ensure your Express Request type is augmented or use `any` for now if needed
      (request as any).user = user; // Standard practice is to attach to `request.user`

      this.logger.debug(`User ${user.id} authenticated successfully.`);
      return true; // Allow access

    } catch (error) {
        // Catch exceptions thrown from within the try block (like UnauthorizedException)
        // and re-throw them, or handle unexpected errors.
        if (error instanceof UnauthorizedException) {
            throw error; // Re-throw specific auth exceptions
        }
        // Log unexpected errors during the process
        this.logger.error(`Unexpected error during authentication: ${error.message}`, error.stack);
        throw new UnauthorizedException('Authentication failed due to an internal error');
    }
  }

  // Helper function to extract 'Bearer <token>'
  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
} 