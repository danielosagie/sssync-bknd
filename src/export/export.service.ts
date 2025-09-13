import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { SupabaseService } from '../common/supabase.service';
import { v4 as uuidv4 } from 'uuid';

export interface ExportJobData {
  userId: string;
  exportType: 'csv' | 'shopify' | 'square' | 'clover' | 'ebay' | 'facebook' | 'whatnot';
  format: 'csv' | 'platform-specific';
  filters?: {
    connectionId?: string;
    productIds?: string[];
    includeArchived?: boolean;
    dateRange?: { start: string; end: string };
  };
  options?: {
    includeImages?: boolean;
    includeInventory?: boolean;
    includeVariants?: boolean;
  };
}

export interface ExportJob {
  Id: string;
  UserId: string;
  ExportType: string;
  Format: string;
  Status: 'queued' | 'processing' | 'completed' | 'failed';
  Progress: number;
  Description: string;
  Filters: any;
  Options: any;
  ResultFileUrl?: string;
  ErrorMessage?: string;
  CreatedAt: string;
  UpdatedAt: string;
}

@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    @InjectQueue('export-jobs') private readonly exportQueue: Queue,
  ) {}

  async createExportJob(userId: string, jobData: ExportJobData): Promise<{ jobId: string; estimatedDuration: string }> {
    const jobId = uuidv4();
    
    // Create export job record
    const supabase = this.supabaseService.getClient();
    const { error } = await supabase.from('ExportJobs').insert({
      Id: jobId,
      UserId: userId,
      ExportType: jobData.exportType,
      Format: jobData.format,
      Status: 'queued',
      Progress: 0,
      Description: 'Export job queued',
      Filters: jobData.filters || {},
      Options: jobData.options || {},
    });

    if (error) {
      this.logger.error(`Failed to create export job: ${error.message}`);
      throw new Error(`Failed to create export job: ${error.message}`);
    }

    // Enqueue the job
    await this.exportQueue.add('process-export', {
      ...jobData,
      jobId,
    }, {
      jobId: jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 30000 },
    });

    // Estimate duration based on export type and complexity
    const estimatedDuration = this.estimateExportDuration(jobData);

    this.logger.log(`Created export job ${jobId} for user ${userId}`);
    return { jobId, estimatedDuration };
  }

  async getExportJobStatus(userId: string, jobId: string): Promise<ExportJob | null> {
    const supabase = this.supabaseService.getClient();
    const { data, error } = await supabase
      .from('ExportJobs')
      .select('*')
      .eq('UserId', userId)
      .eq('Id', jobId)
      .maybeSingle();

    if (error) {
      this.logger.error(`Failed to get export job status: ${error.message}`);
      return null;
    }

    return data;
  }

  async getUserExportJobs(userId: string, limit = 20): Promise<ExportJob[]> {
    const supabase = this.supabaseService.getClient();
    const { data, error } = await supabase
      .from('ExportJobs')
      .select('*')
      .eq('UserId', userId)
      .order('CreatedAt', { ascending: false })
      .limit(limit);

    if (error) {
      this.logger.error(`Failed to get user export jobs: ${error.message}`);
      return [];
    }

    return data || [];
  }

  async updateExportJobProgress(
    jobId: string, 
    progress: number, 
    description: string,
    status?: 'processing' | 'completed' | 'failed',
    resultFileUrl?: string,
    errorMessage?: string
  ): Promise<void> {
    const supabase = this.supabaseService.getClient();
    const updates: any = {
      Progress: progress,
      Description: description,
      UpdatedAt: new Date().toISOString(),
    };

    if (status) updates.Status = status;
    if (resultFileUrl) updates.ResultFileUrl = resultFileUrl;
    if (errorMessage) updates.ErrorMessage = errorMessage;

    const { error } = await supabase
      .from('ExportJobs')
      .update(updates)
      .eq('Id', jobId);

    if (error) {
      this.logger.error(`Failed to update export job progress: ${error.message}`);
    }
  }

  private estimateExportDuration(jobData: ExportJobData): string {
    // Base estimates in minutes
    const baseEstimates = {
      csv: 2,
      shopify: 5,
      square: 4,
      clover: 4,
      ebay: 8,
      facebook: 6,
      whatnot: 10,
    };

    let estimate = baseEstimates[jobData.exportType] || 5;

    // Adjust based on options
    if (jobData.options?.includeImages) estimate *= 1.5;
    if (jobData.options?.includeInventory) estimate *= 1.2;
    if (jobData.filters?.productIds?.length && jobData.filters.productIds.length > 1000) {
      estimate *= 2;
    }

    return estimate < 60 ? `${Math.ceil(estimate)} minutes` : `${Math.ceil(estimate / 60)} hours`;
  }
}










