// src/common/guards/subscription-limit.guard.ts
import { Injectable, CanActivate, ExecutionContext, ForbiddenException, InternalServerErrorException, Logger, Inject } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseService } from '../common/supabase.service'; // Adjust path
import { LIMIT_TYPE_KEY, LimitType } from './limit-type.decorator'; // We'll create this decorator

@Injectable()
export class SubscriptionLimitGuard implements CanActivate {
  private readonly logger = new Logger(SubscriptionLimitGuard.name);
  private supabase: SupabaseClient;

  constructor(
    private reflector: Reflector,
    // Inject SupabaseService instead of UsersService to directly query tables if needed
    private supabaseService: SupabaseService,
    // TODO: Inject a UsageTrackingService later
  ) {
     this.supabase = this.supabaseService.getClient();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const limitType = this.reflector.getAllAndOverride<LimitType | undefined>(LIMIT_TYPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // If no limit type is specified on the route, allow access
    if (!limitType) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user; // Assumes SupabaseAuthGuard or similar ran first

    if (!user || !user.id) {
      this.logger.warn('SubscriptionLimitGuard: No user found on request. Denying access.');
      throw new ForbiddenException('User authentication required.');
    }

    const userId = user.id;

    // --- Fetch User Tier ---
    const { data: userData, error: userError } = await this.supabase
      .from('Users')
      .select('SubscriptionTierId') // Select only the needed field
      .eq('Id', userId)
      .maybeSingle();

    if (userError) {
        this.logger.error(`Error fetching user ${userId} for limit check: ${userError.message}`);
        throw new InternalServerErrorException('Error checking user subscription.');
    }
    if (!userData || !userData.SubscriptionTierId) {
        this.logger.warn(`User ${userId} has no subscription tier set. Applying default deny/free tier logic.`);
        // TODO: Implement logic for users without a tier (e.g., deny or check against a default 'free' tier definition)
        throw new ForbiddenException('Subscription required for this feature.');
    }

    const tierId = userData.SubscriptionTierId;

    // --- Fetch Tier Limits ---
    const { data: tierData, error: tierError } = await this.supabase
       .from('SubscriptionTiers')
       .select('ProductLimit, SyncOperationLimit, AiScans') // Select potential limit columns
       .eq('Id', tierId)
       .single(); // Use single() as tier ID should exist if user linked

    if (tierError || !tierData) {
        this.logger.error(`Error fetching tier ${tierId} for user ${userId}: ${tierError?.message || 'Tier not found'}`);
        // Maybe allow access but log an error? Or deny? Denying is safer.
        throw new InternalServerErrorException('Error retrieving subscription limits.');
    }

    // --- Check Specific Limit ---
    let limit: number | null = null;
    switch (limitType) {
        case LimitType.AI_SCAN:
             limit = tierData.AiScans;
             break;
        case LimitType.SYNC_OPERATION:
             limit = tierData.SyncOperationLimit;
             break;
         case LimitType.PRODUCT:
             limit = tierData.ProductLimit;
             break;
        // Add cases for other limit types
        default:
            this.logger.warn(`SubscriptionLimitGuard: Unknown limit type "${limitType}" specified.`);
            return true; // Allow if limit type isn't recognized? Or deny?
    }

    // If limit is null or undefined, it means unlimited for this tier
    if (limit === null || limit === undefined) {
      this.logger.debug(`User ${userId} on tier ${tierId} has unlimited access for ${limitType}.`);
      return true;
    }

    // --- TODO: Implement Usage Tracking Check ---
    this.logger.warn(`Usage tracking check for limit type "${limitType}" is NOT YET IMPLEMENTED.`);
    // 1. Get current usage count for the user and this limitType (e.g., from Redis or DB)
    // const currentUsage = await this.usageTrackingService.getCurrentUsage(userId, limitType);
    const currentUsage = 0; // Placeholder!

    // 2. Compare usage with the limit
    if (currentUsage < limit) {
       this.logger.debug(`User ${userId} usage (${currentUsage}) is below limit (${limit}) for ${limitType}. Allowing access.`);
       // Optionally: Increment usage count *after* allowing access? Or do it in the service method itself?
       // await this.usageTrackingService.incrementUsage(userId, limitType); // Maybe do this elsewhere
       return true;
    } else {
       this.logger.warn(`User ${userId} has reached the limit (${limit}) for ${limitType}. Denying access.`);
       throw new ForbiddenException(`You have reached the usage limit for ${limitType} on your current plan.`);
    }
    // --- End Usage Tracking Check ---
  }
}