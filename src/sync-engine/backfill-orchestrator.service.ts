import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { SupabaseService } from '../common/supabase.service';
import { ActivityLogService } from '../common/activity-log.service';
import { PlatformConnectionsService, PlatformConnection } from '../platform-connections/platform-connections.service';

export interface BackfillJob {
  Id: string;
  UserId: string;
  ConnectionId: string;
  JobType: 'data_gap_analysis' | 'bulk_ai_backfill' | 'photo_request' | 'description_generation' | 'tag_generation' | 'barcode_scanning';
  Status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  Priority: 'low' | 'medium' | 'high' | 'urgent';
  Progress: number; // 0-100
  TotalItems: number;
  ProcessedItems: number;
  FailedItems: number;
  Metadata: {
    platformType: string;
    missingDataTypes: string[];
    estimatedCost?: number;
    aiModelUsed?: string;
    userPreferences?: Record<string, any>;
  };
  StartedAt?: string;
  CompletedAt?: string;
  ErrorMessage?: string;
  CreatedAt: string;
  UpdatedAt: string;
}

export interface DataGapAnalysis {
  connectionId: string;
  platformType: string;
  totalProducts: number;
  gaps: {
    missingPhotos: number;
    missingDescriptions: number;
    missingTags: number;
    missingBarcodes: number;
    missingPricing: number;
    missingInventory: number;
  };
  recommendations: {
    priority: 'low' | 'medium' | 'high' | 'urgent';
    action: string;
    estimatedCost?: number;
    estimatedTime?: string;
  }[];
}

export interface BackfillItem {
  Id: string;
  BackfillJobId: string;
  ProductVariantId: string;
  DataType: 'photo' | 'description' | 'tags' | 'barcode' | 'pricing' | 'inventory';
  Status: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped';
  OriginalValue?: any;
  GeneratedValue?: any;
  Confidence?: number;
  AiModelUsed?: string;
  ProcessingTime?: number;
  ErrorMessage?: string;
  CreatedAt: string;
  UpdatedAt: string;
}

@Injectable()
export class BackfillOrchestratorService {
  private readonly logger = new Logger(BackfillOrchestratorService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly activityLogService: ActivityLogService,
    private readonly platformConnectionsService: PlatformConnectionsService,
    @InjectQueue('backfill-jobs') private readonly backfillQueue: Queue,
  ) {}

  /**
   * Analyzes data gaps for a newly connected platform
   */
  async analyzeDataGaps(connectionId: string, userId: string): Promise<DataGapAnalysis> {
    const supabase = this.supabaseService.getClient();
    
    // Get connection details
    const connection = await this.platformConnectionsService.getConnectionById(connectionId, userId);
    if (!connection) {
      throw new Error('Platform connection not found');
    }

    // Get all products mapped to this platform
    const { data: mappedProducts, error: productsError } = await supabase
      .from('PlatformProductMappings')
      .select(`
        ProductVariantId,
        ProductVariants (
          Id,
          Title,
          Description,
          Barcode,
          Price,
          ProductImages (ImageUrl)
        )
      `)
      .eq('PlatformConnectionId', connectionId)
      .eq('IsEnabled', true);

    if (productsError) {
      this.logger.error(`Error fetching mapped products: ${productsError.message}`);
      throw new Error('Failed to analyze data gaps');
    }

    const gaps = {
      missingPhotos: 0,
      missingDescriptions: 0,
      missingTags: 0,
      missingBarcodes: 0,
      missingPricing: 0,
      missingInventory: 0,
    };

    const totalProducts = mappedProducts?.length || 0;

    // Analyze gaps for each product
    mappedProducts?.forEach((mapping: any) => {
      const variant = mapping.ProductVariants;
      
      // Check for missing photos
      if (!variant.ProductImages || variant.ProductImages.length === 0) {
        gaps.missingPhotos++;
      }
      
      // Check for missing descriptions
      if (!variant.Description || variant.Description.trim() === '') {
        gaps.missingDescriptions++;
      }
      
      // Check for missing barcodes
      if (!variant.Barcode || variant.Barcode.trim() === '') {
        gaps.missingBarcodes++;
      }
      
      // Check for missing pricing
      if (!variant.Price || variant.Price <= 0) {
        gaps.missingPricing++;
      }
    });

    // Generate recommendations based on gaps
    const recommendations = this.generateRecommendations(gaps, connection.PlatformType);

    return {
      connectionId,
      platformType: connection.PlatformType,
      totalProducts,
      gaps,
      recommendations,
    };
  }

  /**
   * Creates a comprehensive backfill job for a platform
   */
  async createBackfillJob(
    userId: string,
    connectionId: string,
    jobType: BackfillJob['JobType'],
    dataTypes: string[],
    priority: BackfillJob['Priority'] = 'medium',
    userPreferences?: Record<string, any>,
  ): Promise<BackfillJob> {
    const supabase = this.supabaseService.getClient();
    
    // Get connection details
    const connection = await this.platformConnectionsService.getConnectionById(connectionId, userId);
    if (!connection) {
      throw new Error('Platform connection not found');
    }

    // Analyze gaps to get total items
    const gapAnalysis = await this.analyzeDataGaps(connectionId, userId);
    const totalItems = this.calculateTotalItems(gapAnalysis.gaps, dataTypes);

    // Create backfill job
    const { data: job, error } = await supabase
      .from('BackfillJobs')
      .insert({
        UserId: userId,
        ConnectionId: connectionId,
        JobType: jobType,
        Status: 'pending',
        Priority: priority,
        Progress: 0,
        TotalItems: totalItems,
        ProcessedItems: 0,
        FailedItems: 0,
        Metadata: {
          platformType: connection.PlatformType,
          missingDataTypes: dataTypes,
          userPreferences,
        },
      })
      .select()
      .single();

    if (error) {
      this.logger.error(`Error creating backfill job: ${error.message}`);
      throw new Error('Failed to create backfill job');
    }

    // Log activity
    await this.activityLogService.logActivity({
      UserId: userId,
      EntityType: 'BackfillJob',
      EntityId: job.Id,
      EventType: 'BACKFILL_JOB_CREATED',
      Status: 'Info',
      Message: `Created ${jobType} backfill job for ${connection.PlatformType}`,
      Details: {
        jobType,
        dataTypes,
        totalItems,
        priority,
      },
    });

    // Enqueue the job for processing
    await this.enqueueBackfillJob(job);

    return job;
  }

  /**
   * Enqueues a backfill job for processing
   */
  private async enqueueBackfillJob(job: BackfillJob): Promise<void> {
    await this.backfillQueue.add('process-backfill', {
      jobId: job.Id,
      userId: job.UserId,
      connectionId: job.ConnectionId,
      jobType: job.JobType,
      dataTypes: job.Metadata.missingDataTypes,
      userPreferences: job.Metadata.userPreferences,
    }, {
      priority: this.getJobPriority(job.Priority),
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
    });

    this.logger.log(`Enqueued backfill job ${job.Id} for processing`);
  }

  /**
   * Gets the priority value for BullMQ
   */
  private getJobPriority(priority: BackfillJob['Priority']): number {
    switch (priority) {
      case 'urgent': return 1;
      case 'high': return 2;
      case 'medium': return 3;
      case 'low': return 4;
      default: return 3;
    }
  }

  /**
   * Calculates total items for backfill based on data types
   */
  private calculateTotalItems(gaps: DataGapAnalysis['gaps'], dataTypes: string[]): number {
    let total = 0;
    
    dataTypes.forEach(type => {
      switch (type) {
        case 'photo':
          total += gaps.missingPhotos;
          break;
        case 'description':
          total += gaps.missingDescriptions;
          break;
        case 'tags':
          total += gaps.missingTags;
          break;
        case 'barcode':
          total += gaps.missingBarcodes;
          break;
        case 'pricing':
          total += gaps.missingPricing;
          break;
        case 'inventory':
          total += gaps.missingInventory;
          break;
      }
    });
    
    return total;
  }

  /**
   * Generates recommendations based on data gaps
   */
  private generateRecommendations(gaps: DataGapAnalysis['gaps'], platformType: string): DataGapAnalysis['recommendations'] {
    const recommendations: DataGapAnalysis['recommendations'] = [];

    // Photo recommendations
    if (gaps.missingPhotos > 0) {
      recommendations.push({
        priority: gaps.missingPhotos > 50 ? 'high' : 'medium',
        action: `Generate ${gaps.missingPhotos} product photos using AI`,
        estimatedCost: gaps.missingPhotos * 0.05, // $0.05 per photo
        estimatedTime: `${Math.ceil(gaps.missingPhotos / 10)} hours`,
      });
    }

    // Description recommendations
    if (gaps.missingDescriptions > 0) {
      recommendations.push({
        priority: gaps.missingDescriptions > 100 ? 'high' : 'medium',
        action: `Generate ${gaps.missingDescriptions} product descriptions`,
        estimatedCost: gaps.missingDescriptions * 0.02, // $0.02 per description
        estimatedTime: `${Math.ceil(gaps.missingDescriptions / 50)} hours`,
      });
    }

    // Barcode recommendations
    if (gaps.missingBarcodes > 0) {
      recommendations.push({
        priority: 'low',
        action: `Request barcode scanning for ${gaps.missingBarcodes} products`,
        estimatedCost: 0,
        estimatedTime: `${Math.ceil(gaps.missingBarcodes / 20)} hours`,
      });
    }

    // Platform-specific recommendations
    if (platformType.toLowerCase() === 'facebook' || platformType.toLowerCase() === 'ebay') {
      if (gaps.missingPhotos > 0) {
        recommendations.push({
          priority: 'urgent',
          action: 'Photos are critical for marketplace success - prioritize photo generation',
          estimatedCost: gaps.missingPhotos * 0.05,
          estimatedTime: `${Math.ceil(gaps.missingPhotos / 5)} hours`,
        });
      }
    }

    return recommendations;
  }

  /**
   * Gets backfill job progress
   */
  async getBackfillJobProgress(jobId: string, userId: string): Promise<BackfillJob | null> {
    const supabase = this.supabaseService.getClient();
    
    const { data: job, error } = await supabase
      .from('BackfillJobs')
      .select('*')
      .eq('Id', jobId)
      .eq('UserId', userId)
      .single();

    if (error) {
      this.logger.error(`Error fetching backfill job: ${error.message}`);
      return null;
    }

    return job;
  }

  /**
   * Gets all backfill jobs for a user
   */
  async getUserBackfillJobs(userId: string, limit = 50): Promise<BackfillJob[]> {
    const supabase = this.supabaseService.getClient();
    
    const { data: jobs, error } = await supabase
      .from('BackfillJobs')
      .select('*')
      .eq('UserId', userId)
      .order('CreatedAt', { ascending: false })
      .limit(limit);

    if (error) {
      this.logger.error(`Error fetching user backfill jobs: ${error.message}`);
      return [];
    }

    return jobs || [];
  }

  /**
   * Cancels a backfill job
   */
  async cancelBackfillJob(jobId: string, userId: string): Promise<boolean> {
    const supabase = this.supabaseService.getClient();
    
    const { error } = await supabase
      .from('BackfillJobs')
      .update({
        Status: 'cancelled',
        UpdatedAt: new Date().toISOString(),
      })
      .eq('Id', jobId)
      .eq('UserId', userId);

    if (error) {
      this.logger.error(`Error cancelling backfill job: ${error.message}`);
      return false;
    }

    // Log activity
    await this.activityLogService.logActivity({
      UserId: userId,
      EntityType: 'BackfillJob',
      EntityId: jobId,
      EventType: 'BACKFILL_JOB_CANCELLED',
      Status: 'Info',
      Message: 'Backfill job cancelled by user',
    });

    return true;
  }

  /**
   * Gets backfill items for a specific job
   */
  async getBackfillJobItems(jobId: string, userId: string): Promise<BackfillItem[]> {
    const supabase = this.supabaseService.getClient();
    
    // Verify job ownership
    const { data: job } = await supabase
      .from('BackfillJobs')
      .select('Id')
      .eq('Id', jobId)
      .eq('UserId', userId)
      .single();

    if (!job) {
      return [];
    }

    const { data: items, error } = await supabase
      .from('BackfillItems')
      .select('*')
      .eq('BackfillJobId', jobId)
      .order('CreatedAt', { ascending: false });

    if (error) {
      this.logger.error(`Error fetching backfill items: ${error.message}`);
      return [];
    }

    return items || [];
  }
}
        