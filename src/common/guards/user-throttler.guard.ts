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
    const userId = req.user?.id || req.headers['x-user-id'];
    const ip = req.ip || req.connection.remoteAddress;
    const tracker = userId || ip;
    
    this.logger.debug(
      `Throttle check for ${req.method} ${req.url}` +
      `\nUser: ${userId || 'anonymous'}` +
      `\nIP: ${ip}` +
      `\nTracker: ${tracker}`
    );
    
    return tracker;
  }

  async canActivate(context: any): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const handler = context.getHandler();
    const classRef = context.getClass();
    
    this.logger.debug(
      `Throttle check for ${classRef.name}.${handler.name}` +
      `\nMethod: ${request.method}` +
      `\nURL: ${request.url}` +
      `\nUser: ${request.user?.id || 'anonymous'}`
    );

    const result = await super.canActivate(context);
    
    if (!result) {
      this.logger.warn(
        `Throttle limit exceeded for ${classRef.name}.${handler.name}` +
        `\nMethod: ${request.method}` +
        `\nURL: ${request.url}` +
        `\nUser: ${request.user?.id || 'anonymous'}`
      );
    }

    return result;
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
