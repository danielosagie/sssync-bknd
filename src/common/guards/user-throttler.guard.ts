import { ThrottlerGuard } from '@nestjs/throttler';
import { Injectable, ExecutionContext, Logger } from '@nestjs/common';

@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  private readonly logger = new Logger(UserThrottlerGuard.name);

  /**
   * Override getTracker to use User ID if available, otherwise fallback to IP.
   * Assumes a preceding AuthGuard has attached `req.user.id`.
   */
  protected async getTracker(req: Record<string, any>): Promise<string> {
    // Check if user object and user ID exist on the request (populated by AuthGuard)
    const userId = req.user?.id;

    if (userId) {
      // Use the authenticated user's ID as the tracker key
      // this.logger.verbose(`Rate limiting tracker: User ${userId}`); // Optional: Verbose logging
      return userId;
    } else {
      // For unauthenticated requests, fall back to the default IP address tracking
      const ip = req.ips?.length ? req.ips[0] : req.ip; // Standard way ThrottlerGuard gets IP
      // this.logger.verbose(`Rate limiting tracker: IP ${ip}`); // Optional: Verbose logging
      if (!ip) {
          // Should rarely happen, but have a fallback
          this.logger.warn('Could not determine tracker for rate limiting (no userId or IP). Using generic key.');
          return 'generic-tracker'; // Fallback key
      }
      return ip;
    }
  }

  // Optional: Override handleRequest for more detailed logging if needed
  // async handleRequest(
  //   context: ExecutionContext,
  //   limit: number,
  //   ttl: number,
  //   throttler: ThrottlerOptions, // Note: Adjust type based on your NestJS version if needed
  // ): Promise<boolean> {
  //   const tracker = await this.getTracker(context.switchToHttp().getRequest());
  //   this.logger.log(`Handling rate limit request for tracker: ${tracker}, limit: ${limit}, ttl: ${ttl}`);
  //   return super.handleRequest(context, limit, ttl, throttler);
  // }
}
