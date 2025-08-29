import { Injectable, Logger } from '@nestjs/common';
import { ActivityLogService } from './activity-log.service';
import { SupabaseService } from './supabase.service';

export interface EnhancedActivityMetrics {
  totalEvents: number;
  eventsByType: Record<string, number>;
  eventsByPlatform: Record<string, number>;
  successRate: number;
  averageProcessingTime: number;
  recentErrors: Array<{
    timestamp: string;
    message: string;
    platform: string;
    entityType: string;
  }>;
  syncPerformance: {
    totalSyncs: number;
    successfulSyncs: number;
    failedSyncs: number;
    averageSyncDuration: number;
  };
}

export interface SyncOpportunity {
  type: 'missing_mapping' | 'failed_sync' | 'conflict_pattern' | 'performance_issue';
  priority: 'high' | 'medium' | 'low';
  title: string;
  description: string;
  affectedEntities: string[];
  suggestedAction: string;
  estimatedImpact: string;
}

@Injectable()
export class EnhancedActivityLogService {
  private readonly logger = new Logger(EnhancedActivityLogService.name);

  constructor(
    private readonly activityLogService: ActivityLogService,
    private readonly supabaseService: SupabaseService,
  ) {}

  async getActivityMetrics(userId: string, timeRange = '7d'): Promise<EnhancedActivityMetrics> {
    const supabase = this.supabaseService.getClient();
    
    // Calculate date range
    const endDate = new Date();
    const startDate = new Date();
    switch (timeRange) {
      case '24h':
        startDate.setHours(startDate.getHours() - 24);
        break;
      case '7d':
        startDate.setDate(startDate.getDate() - 7);
        break;
      case '30d':
        startDate.setDate(startDate.getDate() - 30);
        break;
      default:
        startDate.setDate(startDate.getDate() - 7);
    }

    // Get activity data
    const { data: activities, error } = await supabase
      .from('ActivityLog')
      .select('*')
      .eq('UserId', userId)
      .gte('CreatedAt', startDate.toISOString())
      .lte('CreatedAt', endDate.toISOString())
      .order('CreatedAt', { ascending: false });

    if (error) {
      this.logger.error(`Failed to get activity metrics: ${error.message}`);
      return this.getEmptyMetrics();
    }

    if (!activities || activities.length === 0) {
      return this.getEmptyMetrics();
    }

    // Calculate metrics
    const totalEvents = activities.length;
    const eventsByType: Record<string, number> = {};
    const eventsByPlatform: Record<string, number> = {};
    const successfulEvents = activities.filter(a => a.Status === 'Success').length;
    const recentErrors = activities
      .filter(a => a.Status === 'Error')
      .slice(0, 10)
      .map(a => ({
        timestamp: a.CreatedAt,
        message: a.Message,
        platform: a.Details?.platform || 'unknown',
        entityType: a.EntityType,
      }));

    // Group by event type
    activities.forEach(activity => {
      const eventType = activity.EventType;
      eventsByType[eventType] = (eventsByType[eventType] || 0) + 1;

      const platform = activity.Details?.platform || activity.Details?.platformType || 'unknown';
      eventsByPlatform[platform] = (eventsByPlatform[platform] || 0) + 1;
    });

    // Calculate sync-specific metrics
    const syncEvents = activities.filter(a => 
      a.EventType.includes('SYNC') || 
      a.EventType.includes('WEBHOOK') || 
      a.EventType.includes('PUSH')
    );
    const successfulSyncs = syncEvents.filter(a => a.Status === 'Success').length;
    const failedSyncs = syncEvents.filter(a => a.Status === 'Error').length;

    return {
      totalEvents,
      eventsByType,
      eventsByPlatform,
      successRate: totalEvents > 0 ? (successfulEvents / totalEvents) * 100 : 0,
      averageProcessingTime: this.calculateAverageProcessingTime(activities),
      recentErrors,
      syncPerformance: {
        totalSyncs: syncEvents.length,
        successfulSyncs,
        failedSyncs,
        averageSyncDuration: this.calculateAverageSyncDuration(syncEvents),
      },
    };
  }

  async identifySyncOpportunities(userId: string): Promise<SyncOpportunity[]> {
    const opportunities: SyncOpportunity[] = [];
    const supabase = this.supabaseService.getClient();

    // Look for patterns in the last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { data: activities } = await supabase
      .from('ActivityLog')
      .select('*')
      .eq('UserId', userId)
      .gte('CreatedAt', thirtyDaysAgo.toISOString())
      .order('CreatedAt', { ascending: false });

    if (!activities) return opportunities;

    // Identify missing mappings
    const mappingErrors = activities.filter(a => 
      a.EventType.includes('MAPPING') && a.Status === 'Error'
    );
    if (mappingErrors.length > 5) {
      opportunities.push({
        type: 'missing_mapping',
        priority: 'high',
        title: 'Multiple Mapping Failures Detected',
        description: `${mappingErrors.length} mapping errors in the last 30 days`,
        affectedEntities: [...new Set(mappingErrors.map(e => e.EntityId))],
        suggestedAction: 'Review and fix product mappings to improve sync reliability',
        estimatedImpact: 'Could improve sync success rate by 15-25%',
      });
    }

    // Identify frequent sync failures
    const syncFailures = activities.filter(a => 
      a.EventType.includes('SYNC') && a.Status === 'Error'
    );
    const failuresByPlatform = syncFailures.reduce((acc, failure) => {
      const platform = failure.Details?.platform || 'unknown';
      acc[platform] = (acc[platform] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    Object.entries(failuresByPlatform).forEach(([platform, count]) => {
      if ((count as number) > 10) {
        opportunities.push({
          type: 'failed_sync',
          priority: 'medium',
          title: `Frequent ${platform} Sync Failures`,
          description: `${count} sync failures on ${platform} platform`,
          affectedEntities: syncFailures
            .filter(f => f.Details?.platform === platform)
            .map(f => f.EntityId),
          suggestedAction: `Check ${platform} API credentials and connection health`,
          estimatedImpact: 'Could reduce sync failures by 40-60%',
        });
      }
    });

    // Identify conflict patterns
    const conflicts = activities.filter(a => a.EventType.includes('CONFLICT'));
    if (conflicts.length > 20) {
      opportunities.push({
        type: 'conflict_pattern',
        priority: 'medium',
        title: 'High Conflict Rate Detected',
        description: `${conflicts.length} conflicts resolved in the last 30 days`,
        affectedEntities: [...new Set(conflicts.map(c => c.EntityId))],
        suggestedAction: 'Review conflict resolution rules and sync timing',
        estimatedImpact: 'Could reduce conflicts by 30-50%',
      });
    }

    // Identify performance issues
    const slowOperations = activities.filter(a => 
      a.Details?.processingTime && a.Details.processingTime > 10000 // > 10 seconds
    );
    if (slowOperations.length > 5) {
      opportunities.push({
        type: 'performance_issue',
        priority: 'low',
        title: 'Slow Operations Detected',
        description: `${slowOperations.length} operations took over 10 seconds`,
        affectedEntities: slowOperations.map(o => o.EntityId),
        suggestedAction: 'Optimize slow operations and consider batch processing',
        estimatedImpact: 'Could improve overall sync speed by 20-40%',
      });
    }

    return opportunities.sort((a, b) => {
      const priorityOrder = { high: 3, medium: 2, low: 1 };
      return priorityOrder[b.priority] - priorityOrder[a.priority];
    });
  }

  async logSyncPerformance(
    userId: string,
    operationType: string,
    platform: string,
    duration: number,
    success: boolean,
    details?: any
  ): Promise<void> {
    await this.activityLogService.logActivity({
      UserId: userId,
      EntityType: 'SyncPerformance',
      EntityId: `${operationType}-${Date.now()}`,
      EventType: 'SYNC_PERFORMANCE_LOGGED',
      Status: success ? 'Success' : 'Error',
      Message: `${operationType} on ${platform} took ${duration}ms`,
      Details: {
        platform,
        operationType,
        duration,
        success,
        ...details,
      },
    });
  }

  async exportActivityReport(userId: string, format: 'csv' | 'json' = 'csv'): Promise<string> {
    const supabase = this.supabaseService.getClient();
    
    const { data: activities } = await supabase
      .from('ActivityLog')
      .select('*')
      .eq('UserId', userId)
      .order('CreatedAt', { ascending: false })
      .limit(10000);

    if (!activities || activities.length === 0) {
      return format === 'csv' ? 'No data available' : '[]';
    }

    if (format === 'json') {
      return JSON.stringify(activities, null, 2);
    }

    // CSV format
    const headers = ['Timestamp', 'Entity Type', 'Event Type', 'Status', 'Message', 'Platform'];
    const rows = activities.map(activity => [
      activity.CreatedAt,
      activity.EntityType,
      activity.EventType,
      activity.Status,
      activity.Message,
      activity.Details?.platform || 'N/A',
    ]);

    return [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');
  }

  private getEmptyMetrics(): EnhancedActivityMetrics {
    return {
      totalEvents: 0,
      eventsByType: {},
      eventsByPlatform: {},
      successRate: 0,
      averageProcessingTime: 0,
      recentErrors: [],
      syncPerformance: {
        totalSyncs: 0,
        successfulSyncs: 0,
        failedSyncs: 0,
        averageSyncDuration: 0,
      },
    };
  }

  private calculateAverageProcessingTime(activities: any[]): number {
    const withProcessingTime = activities.filter(a => a.Details?.processingTime);
    if (withProcessingTime.length === 0) return 0;
    
    const total = withProcessingTime.reduce((sum, a) => sum + a.Details.processingTime, 0);
    return Math.round(total / withProcessingTime.length);
  }

  private calculateAverageSyncDuration(syncEvents: any[]): number {
    const withDuration = syncEvents.filter(e => e.Details?.duration);
    if (withDuration.length === 0) return 0;
    
    const total = withDuration.reduce((sum, e) => sum + e.Details.duration, 0);
    return Math.round(total / withDuration.length);
  }
}
