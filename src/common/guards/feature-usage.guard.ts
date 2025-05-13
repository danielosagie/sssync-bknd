import { Injectable, CanActivate, ExecutionContext, Logger, HttpException, HttpStatus, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SupabaseService } from '../supabase.service'; // Adjust path if needed

export const FEATURE_KEY_METADATA = 'featureKey';
export const Feature = (featureKey: string) => SetMetadata(FEATURE_KEY_METADATA, featureKey);

@Injectable()
export class FeatureUsageGuard implements CanActivate {
    private readonly logger = new Logger(FeatureUsageGuard.name);

    constructor(
        private readonly reflector: Reflector,
        private readonly supabaseService: SupabaseService,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const featureKey = this.reflector.get<string>(FEATURE_KEY_METADATA, context.getHandler());
        if (!featureKey) {
            // If no feature key is set on the route handler, allow access (or throw error if mandatory)
            this.logger.warn(`FeatureUsageGuard used without @Feature() decorator on handler: ${context.getClass().name}.${context.getHandler().name}`);
            return true;
        }

        const request = context.switchToHttp().getRequest();
        const user = request.user; // Assumes AuthGuard ran before and populated req.user

        if (!user || !user.id) {
            this.logger.warn('FeatureUsageGuard: No user found on request. Ensure AuthGuard runs first.');
            throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
        }

        const userId = user.id;
        const supabase = this.supabaseService.getClient();

        // Determine the limit column name based on featureKey
        let limitColumn: string;
        if (featureKey === 'aiScans') {
            limitColumn = 'AiScans'; // Column name in SubscriptionTiers
        } else if (featureKey === 'shopify') {
            // For shopify feature, we'll check if the user has a valid Shopify connection
            const { data: connectionData, error: connectionError } = await supabase
                .from('PlatformConnections')
                .select('Id')
                .eq('UserId', userId)
                .eq('PlatformType', 'SHOPIFY')
                .eq('IsEnabled', true)
                .maybeSingle();

            if (connectionError) {
                this.logger.error(`FeatureUsageGuard: Error checking Shopify connection for user ${userId}: ${connectionError.message}`, connectionError);
                throw new HttpException('Internal Server Error checking Shopify connection', HttpStatus.INTERNAL_SERVER_ERROR);
            }

            if (!connectionData) {
                this.logger.warn(`FeatureUsageGuard: User ${userId} has no active Shopify connection. Denying access.`);
                throw new HttpException('Feature not enabled for your subscription', HttpStatus.FORBIDDEN);
            }

            // User has an active Shopify connection, allow access
            return true;
        } else {
            // Add other feature keys and their corresponding column names here
            this.logger.error(`FeatureUsageGuard: Unknown feature key "${featureKey}"`);
            throw new HttpException('Internal Server Error: Feature limit configuration error', HttpStatus.INTERNAL_SERVER_ERROR);
        }

        // Only check limits for features that have a limit column
        if (limitColumn) {
            try {
                // --- Query 1: Get User's Subscription Tier ID ---
                const { data: userData, error: userError } = await supabase
                    .from('Users')
                    .select('SubscriptionTierId') // Select only the FK column
                    .eq('Id', userId)
                    .maybeSingle(); // User might not exist or might not have a tier assigned

                if (userError) {
                     this.logger.error(`FeatureUsageGuard: Error fetching user ${userId}: ${userError.message}`, userError);
                     throw new HttpException('Internal Server Error checking user data', HttpStatus.INTERNAL_SERVER_ERROR);
                }

                const tierId = userData?.SubscriptionTierId;

                if (!tierId) {
                     this.logger.warn(`FeatureUsageGuard: User ${userId} has no SubscriptionTierId assigned. Denying access.`);
                     throw new HttpException(`Subscription tier not found for your account`, HttpStatus.FORBIDDEN);
                }
                // --- End Query 1 ---

                // --- Query 2: Get the limit value from the SubscriptionTiers table ---
                const { data: tierData, error: tierError } = await supabase
                    .from('SubscriptionTiers')
                    .select(limitColumn) // Select the specific limit column dynamically
                    .eq('Id', tierId)
                    .maybeSingle(); // Tier might not exist (data integrity issue?)

                 if (tierError) {
                     this.logger.error(`FeatureUsageGuard: Error fetching tier details for TierID ${tierId}: ${tierError.message}`, tierError);
                     throw new HttpException('Internal Server Error checking subscription limits', HttpStatus.INTERNAL_SERVER_ERROR);
                 }

                 const currentLimit = tierData?.[limitColumn];
                // --- End Query 2 ---

                // --- Check the limit ---
                if (currentLimit === null || currentLimit === undefined) {
                     this.logger.warn(`FeatureUsageGuard: Tier ${tierId} has no limit defined for ${limitColumn}. Denying access.`);
                     throw new HttpException(`Feature limit not configured for your subscription`, HttpStatus.FORBIDDEN);
                }

                if (currentLimit <= 0) {
                    this.logger.log(`FeatureUsageGuard: Limit reached for user ${userId}, feature ${featureKey}. Current limit: ${currentLimit}`);
                    throw new HttpException(`Usage limit reached for this feature`, HttpStatus.TOO_MANY_REQUESTS);
                }

                // Limit is > 0, allow access
                this.logger.debug(`FeatureUsageGuard: Access granted for user ${userId}, feature ${featureKey}. Limit: ${currentLimit}`);
                return true;

            } catch (err) {
                 // Re-throw specific HTTP exceptions, otherwise wrap
                 if (err instanceof HttpException) {
                     throw err;
                 }
                 this.logger.error(`FeatureUsageGuard: Unexpected error for user ${userId}, feature ${featureKey}: ${err.message}`, err.stack);
                 throw new HttpException('Internal Server Error checking usage limits', HttpStatus.INTERNAL_SERVER_ERROR);
            }
        }

        return false;
    }
} 