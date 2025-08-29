import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';
import { ActivityLogService } from '../common/activity-log.service';
import { ProductVariant, InventoryLevel } from '../common/types/supabase.types';

export interface ConflictResolutionRule {
  priority: 'sssync_wins' | 'platform_wins' | 'most_recent' | 'highest_value' | 'user_review';
  applyTo: 'price' | 'inventory' | 'title' | 'description' | 'all';
  platformExceptions?: string[]; // Platform types that override this rule
}

export interface ConflictEvent {
  entityType: 'product' | 'variant' | 'inventory';
  entityId: string;
  conflictType: 'price_mismatch' | 'inventory_mismatch' | 'title_mismatch' | 'concurrent_update';
  sssyncValue: any;
  platformValue: any;
  platformType: string;
  platformConnectionId: string;
  sssyncTimestamp: string; // When sssync data was last updated
  platformTimestamp: string; // When platform data was last updated
  timestamp: string; // When conflict was detected
  resolved: boolean;
  resolution?: {
    action: 'keep_sssync' | 'accept_platform' | 'merge' | 'user_review';
    appliedValue: any;
    reason: string;
  };
}

// Platform-specific behavior rules
export interface PlatformBehaviorRules {
  platformType: string;
  inventoryBehavior: 'reduce_only' | 'delist_after_sale' | 'hybrid';
  delistThreshold: number; // Quantity at which to delist (for delist_after_sale)
  syncInventory: boolean;
  syncPricing: boolean;
  syncMetadata: boolean;
}

@Injectable()
export class ConflictResolutionService {
  private readonly logger = new Logger(ConflictResolutionService.name);

  // Platform behavior rules - how each platform handles inventory
  private readonly platformBehaviors: PlatformBehaviorRules[] = [
    {
      platformType: 'shopify',
      inventoryBehavior: 'reduce_only',
      delistThreshold: 0,
      syncInventory: true,
      syncPricing: true,
      syncMetadata: true,
    },
    {
      platformType: 'square',
      inventoryBehavior: 'reduce_only',
      delistThreshold: 0,
      syncInventory: true,
      syncPricing: true,
      syncMetadata: true,
    },
    {
      platformType: 'clover',
      inventoryBehavior: 'reduce_only',
      delistThreshold: 0,
      syncInventory: true,
      syncPricing: true,
      syncMetadata: true,
    },
    {
      platformType: 'ebay',
      inventoryBehavior: 'hybrid',
      delistThreshold: 0, // eBay can delist at 0 or keep for relisting
      syncInventory: true,
      syncPricing: true,
      syncMetadata: true,
    },
    {
      platformType: 'facebook',
      inventoryBehavior: 'delist_after_sale',
      delistThreshold: 0, // Facebook often delists after sale
      syncInventory: true,
      syncPricing: true,
      syncMetadata: true,
    },
    {
      platformType: 'whatnot',
      inventoryBehavior: 'delist_after_sale',
      delistThreshold: 0, // Whatnot is auction-based, often delists
      syncInventory: true,
      syncPricing: true,
      syncMetadata: true,
    },
  ];

  // Default conflict resolution rules - sssync is SOT
  private readonly defaultRules: ConflictResolutionRule[] = [
    { priority: 'sssync_wins', applyTo: 'price', platformExceptions: [] },
    { priority: 'sssync_wins', applyTo: 'title', platformExceptions: [] },
    { priority: 'sssync_wins', applyTo: 'description', platformExceptions: [] },
    { priority: 'most_recent', applyTo: 'inventory', platformExceptions: ['shopify', 'square'] }, // Inventory can be more fluid
  ];

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  async resolveProductConflict(
    canonicalVariant: ProductVariant,
    incomingPlatformData: any,
    platformType: string,
    connectionId: string,
    userId: string,
    platformTimestamp?: string,
  ): Promise<{ action: string; updatedVariant?: Partial<ProductVariant>; conflicts: ConflictEvent[] }> {
    const conflicts: ConflictEvent[] = [];
    let resolvedVariant: Partial<ProductVariant> = {};
    let hasConflicts = false;

    // Get platform behavior rules
    const platformBehavior = this.getPlatformBehavior(platformType);
    const sssyncTimestamp = canonicalVariant.UpdatedAt;
    const incomingTimestamp = platformTimestamp || new Date().toISOString();

    // Check for price conflicts
    if (incomingPlatformData.price !== undefined && canonicalVariant.Price !== incomingPlatformData.price) {
      const conflict: ConflictEvent = {
        entityType: 'variant',
        entityId: canonicalVariant.Id!,
        conflictType: 'price_mismatch',
        sssyncValue: canonicalVariant.Price,
        platformValue: incomingPlatformData.price,
        platformType,
        platformConnectionId: connectionId,
        sssyncTimestamp,
        platformTimestamp: incomingTimestamp,
        timestamp: new Date().toISOString(),
        resolved: false,
      };

      const resolution = await this.applyConflictRule(conflict, 'price', sssyncTimestamp, incomingTimestamp);
      conflict.resolved = true;
      conflict.resolution = resolution;
      conflicts.push(conflict);

      if (resolution.action === 'accept_platform') {
        resolvedVariant.Price = incomingPlatformData.price;
        hasConflicts = true;
      }
    }

    // Check for title conflicts
    if (incomingPlatformData.title !== undefined && canonicalVariant.Title !== incomingPlatformData.title) {
      const conflict: ConflictEvent = {
        entityType: 'variant',
        entityId: canonicalVariant.Id!,
        conflictType: 'title_mismatch',
        sssyncValue: canonicalVariant.Title,
        platformValue: incomingPlatformData.title,
        platformType,
        platformConnectionId: connectionId,
        sssyncTimestamp,
        platformTimestamp: incomingTimestamp,
        timestamp: new Date().toISOString(),
        resolved: false,
      };

      const resolution = await this.applyConflictRule(conflict, 'title', sssyncTimestamp, incomingTimestamp);
      conflict.resolved = true;
      conflict.resolution = resolution;
      conflicts.push(conflict);

      if (resolution.action === 'accept_platform') {
        resolvedVariant.Title = incomingPlatformData.title;
        hasConflicts = true;
      }
    }

    // Store conflicts for audit
    if (conflicts.length > 0) {
      await this.storeConflictEvents(conflicts, userId);
    }

    // Log conflict resolution activity
    if (hasConflicts) {
      await this.activityLogService.logActivity({
        UserId: userId,
        EntityType: 'ConflictResolution',
        EntityId: canonicalVariant.Id!,
        EventType: 'CONFLICT_RESOLVED',
        Status: 'Info',
        Message: `Resolved ${conflicts.length} conflicts for variant ${canonicalVariant.Title}`,
        Details: {
          platformType,
          connectionId,
          conflicts: conflicts.map(c => ({ type: c.conflictType, action: c.resolution?.action })),
        },
      });

      return { action: 'update_canonical', updatedVariant: resolvedVariant, conflicts };
    }

    return { action: 'no_conflict', conflicts };
  }

  async resolveInventoryConflict(
    canonicalLevel: InventoryLevel,
    incomingQuantity: number,
    platformType: string,
    connectionId: string,
    userId: string,
    platformTimestamp?: string,
  ): Promise<{ action: string; updatedQuantity?: number; shouldDelist?: boolean; conflict?: ConflictEvent }> {
    const platformBehavior = this.getPlatformBehavior(platformType);
    const sssyncTimestamp = canonicalLevel.UpdatedAt;
    const incomingTimestamp = platformTimestamp || new Date().toISOString();

    // Check if this should trigger a delist based on platform behavior
    const shouldDelist = this.shouldDelistProduct(incomingQuantity, platformBehavior);

    const conflict: ConflictEvent = {
      entityType: 'inventory',
      entityId: canonicalLevel.Id!,
      conflictType: 'inventory_mismatch',
      sssyncValue: canonicalLevel.Quantity,
      platformValue: incomingQuantity,
      platformType,
      platformConnectionId: connectionId,
      sssyncTimestamp,
      platformTimestamp: incomingTimestamp,
      timestamp: new Date().toISOString(),
      resolved: false,
    };

    const resolution = await this.applyConflictRule(conflict, 'inventory', sssyncTimestamp, incomingTimestamp);
    conflict.resolved = true;
    conflict.resolution = resolution;

    await this.storeConflictEvents([conflict], userId);

    if (resolution.action === 'accept_platform') {
      await this.activityLogService.logActivity({
        UserId: userId,
        EntityType: 'InventoryConflict',
        EntityId: canonicalLevel.Id!,
        EventType: 'INVENTORY_CONFLICT_RESOLVED',
        Status: 'Info',
        Message: `Inventory conflict resolved: accepting platform value ${incomingQuantity}`,
        Details: { 
          platformType, 
          connectionId, 
          originalQuantity: canonicalLevel.Quantity,
          shouldDelist,
          platformBehavior: platformBehavior.inventoryBehavior,
        },
      });

      return { 
        action: 'update_canonical', 
        updatedQuantity: incomingQuantity, 
        shouldDelist,
        conflict 
      };
    }

    return { action: 'keep_canonical', shouldDelist, conflict };
  }

  /**
   * Determines if a product should be delisted based on platform behavior
   */
  private shouldDelistProduct(quantity: number, platformBehavior: PlatformBehaviorRules): boolean {
    switch (platformBehavior.inventoryBehavior) {
      case 'reduce_only':
        // Never delist, just reduce inventory
        return false;
      
      case 'delist_after_sale':
        // Delist when quantity reaches threshold (usually 0)
        return quantity <= platformBehavior.delistThreshold;
      
      case 'hybrid':
        // Platform-specific logic (e.g., eBay can keep for relisting)
        return quantity <= platformBehavior.delistThreshold;
      
      default:
        return false;
    }
  }

  /**
   * Gets platform behavior rules for a specific platform
   */
  private getPlatformBehavior(platformType: string): PlatformBehaviorRules {
    return this.platformBehaviors.find(pb => pb.platformType.toLowerCase() === platformType.toLowerCase()) || 
           this.platformBehaviors[0]; // Default to first behavior
  }

  private async applyConflictRule(
    conflict: ConflictEvent,
    fieldType: string,
    sssyncTimestamp: string,
    platformTimestamp: string,
  ): Promise<{ action: 'keep_sssync' | 'accept_platform' | 'merge' | 'user_review'; appliedValue: any; reason: string }> {
    const rule = this.defaultRules.find(r => r.applyTo === fieldType || r.applyTo === 'all');
    
    if (!rule) {
      return {
        action: 'keep_sssync',
        appliedValue: conflict.sssyncValue,
        reason: 'No specific rule found, defaulting to sssync SOT',
      };
    }

    // Check platform exceptions
    if (rule.platformExceptions?.includes(conflict.platformType)) {
      return {
        action: 'accept_platform',
        appliedValue: conflict.platformValue,
        reason: `Platform exception for ${conflict.platformType}`,
      };
    }

    switch (rule.priority) {
      case 'sssync_wins':
        return {
          action: 'keep_sssync',
          appliedValue: conflict.sssyncValue,
          reason: 'sssync is source of truth',
        };

      case 'platform_wins':
        return {
          action: 'accept_platform',
          appliedValue: conflict.platformValue,
          reason: 'Platform value preferred',
        };

      case 'most_recent':
        // Compare timestamps to determine which is more recent
        const sssyncTime = new Date(sssyncTimestamp).getTime();
        const platformTime = new Date(platformTimestamp).getTime();
        
        if (platformTime > sssyncTime) {
          return {
            action: 'accept_platform',
            appliedValue: conflict.platformValue,
            reason: `Platform value is more recent (${new Date(platformTimestamp).toISOString()} vs ${new Date(sssyncTimestamp).toISOString()})`,
          };
        } else {
          return {
            action: 'keep_sssync',
            appliedValue: conflict.sssyncValue,
            reason: `sssync value is more recent (${new Date(sssyncTimestamp).toISOString()} vs ${new Date(platformTimestamp).toISOString()})`,
          };
        }

      case 'highest_value':
        if (typeof conflict.sssyncValue === 'number' && typeof conflict.platformValue === 'number') {
                  return conflict.sssyncValue >= conflict.platformValue ? {
          action: 'keep_sssync',
          appliedValue: conflict.sssyncValue,
          reason: 'sssync value is higher',
        } : {
          action: 'accept_platform',
          appliedValue: conflict.platformValue,
          reason: 'Platform value is higher',
        };
        }
        break;

      case 'user_review':
        return {
          action: 'user_review',
          appliedValue: conflict.sssyncValue, // Keep current value until user decides
          reason: 'Conflict requires user review',
        };

      default:
        return {
          action: 'keep_sssync',
          appliedValue: conflict.sssyncValue,
          reason: 'Default to sssync SOT',
        };
    }

    return {
      action: 'keep_sssync',
      appliedValue: conflict.sssyncValue,
      reason: 'Fallback to sssync SOT',
    };
  }

  private async storeConflictEvents(conflicts: ConflictEvent[], userId: string): Promise<void> {
    const supabase = this.supabaseService.getClient();
    
    const conflictRecords = conflicts.map(conflict => ({
      UserId: userId,
      EntityType: conflict.entityType,
      EntityId: conflict.entityId,
      ConflictType: conflict.conflictType,
      SssyncValue: conflict.sssyncValue,
      PlatformValue: conflict.platformValue,
      PlatformType: conflict.platformType,
      PlatformConnectionId: conflict.platformConnectionId,
      Resolution: conflict.resolution,
      ResolvedAt: conflict.resolved ? new Date().toISOString() : null,
    }));

    const { error } = await supabase.from('ConflictEvents').insert(conflictRecords);
    
    if (error) {
      this.logger.error(`Failed to store conflict events: ${error.message}`);
    }
  }

  async getConflictHistory(userId: string, entityId?: string, limit = 50): Promise<ConflictEvent[]> {
    const supabase = this.supabaseService.getClient();
    
    let query = supabase
      .from('ConflictEvents')
      .select('*')
      .eq('UserId', userId)
      .order('CreatedAt', { ascending: false })
      .limit(limit);

    if (entityId) {
      query = query.eq('EntityId', entityId);
    }

    const { data, error } = await query;
    
    if (error) {
      this.logger.error(`Failed to get conflict history: ${error.message}`);
      return [];
    }

    return data || [];
  }
}
