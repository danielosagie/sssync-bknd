import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards, Logger } from '@nestjs/common';
import { BackfillOrchestratorService, DataGapAnalysis, BackfillJob } from './backfill-orchestrator.service';
import { AuthGuard } from '../auth/auth.guard';

// DTOs for request/response
export class CreateBackfillJobDto {
  connectionId: string;
  jobType: 'data_gap_analysis' | 'bulk_ai_backfill' | 'photo_request' | 'description_generation' | 'tag_generation' | 'barcode_scanning';
  dataTypes: string[];
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  userPreferences?: Record<string, any>;
}

export interface DataGapAnalysisResponse {
  success: boolean;
  data?: DataGapAnalysis;
  error?: string;
}

export interface BackfillJobResponse {
  success: boolean;
  data?: BackfillJob;
  error?: string;
}

export interface BackfillJobsResponse {
  success: boolean;
  data?: BackfillJob[];
  error?: string;
}

@Controller('backfill')
@UseGuards(AuthGuard)
export class BackfillController {
  private readonly logger = new Logger(BackfillController.name);

  constructor(
    private readonly backfillOrchestratorService: BackfillOrchestratorService,
  ) {}

  /**
   * Analyze data gaps for a platform connection
   * GET /backfill/analyze/:connectionId
   */
  @Get('analyze/:connectionId')
  async analyzeDataGaps(
    @Param('connectionId') connectionId: string,
    @Query('userId') userId: string,
  ): Promise<DataGapAnalysisResponse> {
    try {
      this.logger.log(`Analyzing data gaps for connection ${connectionId}`);
      
      const analysis = await this.backfillOrchestratorService.analyzeDataGaps(connectionId, userId);
      
      return {
        success: true,
        data: analysis,
      };
    } catch (error) {
      this.logger.error(`Error analyzing data gaps: ${error.message}`);
      
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Create a new backfill job
   * POST /backfill/jobs
   */
  @Post('jobs')
  async createBackfillJob(
    @Body() createJobDto: CreateBackfillJobDto,
    @Query('userId') userId: string,
  ): Promise<BackfillJobResponse> {
    try {
      this.logger.log(`Creating backfill job for connection ${createJobDto.connectionId}`);
      
      const job = await this.backfillOrchestratorService.createBackfillJob(
        userId,
        createJobDto.connectionId,
        createJobDto.jobType,
        createJobDto.dataTypes,
        createJobDto.priority || 'medium',
        createJobDto.userPreferences,
      );
      
      return {
        success: true,
        data: job,
      };
    } catch (error) {
      this.logger.error(`Error creating backfill job: ${error.message}`);
      
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get backfill job progress
   * GET /backfill/jobs/:jobId
   */
  @Get('jobs/:jobId')
  async getBackfillJobProgress(
    @Param('jobId') jobId: string,
    @Query('userId') userId: string,
  ): Promise<BackfillJobResponse> {
    try {
      this.logger.log(`Getting progress for backfill job ${jobId}`);
      
      const job = await this.backfillOrchestratorService.getBackfillJobProgress(jobId, userId);
      
      if (!job) {
        return {
          success: false,
          error: 'Backfill job not found',
        };
      }
      
      return {
        success: true,
        data: job,
      };
    } catch (error) {
      this.logger.error(`Error getting backfill job progress: ${error.message}`);
      
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get all backfill jobs for a user
   * GET /backfill/jobs
   */
  @Get('jobs')
  async getUserBackfillJobs(
    @Query('userId') userId: string,
    @Query('limit') limit?: string,
  ): Promise<BackfillJobsResponse> {
    try {
      this.logger.log(`Getting backfill jobs for user ${userId}`);
      
      const limitNum = limit ? parseInt(limit, 10) : 50;
      const jobs = await this.backfillOrchestratorService.getUserBackfillJobs(userId, limitNum);
      
      return {
        success: true,
        data: jobs,
      };
    } catch (error) {
      this.logger.error(`Error getting user backfill jobs: ${error.message}`);
      
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Cancel a backfill job
   * PUT /backfill/jobs/:jobId/cancel
   */
  @Put('jobs/:jobId/cancel')
  async cancelBackfillJob(
    @Param('jobId') jobId: string,
    @Query('userId') userId: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      this.logger.log(`Cancelling backfill job ${jobId}`);
      
      const cancelled = await this.backfillOrchestratorService.cancelBackfillJob(jobId, userId);
      
      if (!cancelled) {
        return {
          success: false,
          error: 'Failed to cancel backfill job',
        };
      }
      
      return {
        success: true,
      };
    } catch (error) {
      this.logger.error(`Error cancelling backfill job: ${error.message}`);
      
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get backfill items for a specific job
   * GET /backfill/jobs/:jobId/items
   */
  @Get('jobs/:jobId/items')
  async getBackfillJobItems(
    @Param('jobId') jobId: string,
    @Query('userId') userId: string,
  ): Promise<{ success: boolean; data?: any[]; error?: string }> {
    try {
      this.logger.log(`Getting items for backfill job ${jobId}`);
      
      const items = await this.backfillOrchestratorService.getBackfillJobItems(jobId, userId);
      
      return {
        success: true,
        data: items,
      };
    } catch (error) {
      this.logger.error(`Error getting backfill job items: ${error.message}`);
      
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get platform-specific backfill recommendations
   * GET /backfill/recommendations/:platformType
   */
  @Get('recommendations/:platformType')
  async getPlatformRecommendations(
    @Param('platformType') platformType: string,
    @Query('missingPhotos') missingPhotos?: string,
    @Query('missingDescriptions') missingDescriptions?: string,
    @Query('missingBarcodes') missingBarcodes?: string,
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    try {
      this.logger.log(`Getting recommendations for platform ${platformType}`);
      
      // Create mock gaps for demonstration
      const gaps = {
        missingPhotos: parseInt(missingPhotos || '0', 10),
        missingDescriptions: parseInt(missingDescriptions || '0', 10),
        missingTags: 0,
        missingBarcodes: parseInt(missingBarcodes || '0', 10),
        missingPricing: 0,
        missingInventory: 0,
      };
      
      // Generate recommendations based on platform type and gaps
      const recommendations = this.generateMockRecommendations(gaps, platformType);
      
      return {
        success: true,
        data: {
          platformType,
          gaps,
          recommendations,
        },
      };
    } catch (error) {
      this.logger.error(`Error getting platform recommendations: ${error.message}`);
      
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Generate mock recommendations for demonstration
   */
  private generateMockRecommendations(gaps: any, platformType: string): any[] {
    const recommendations: any[] = [];

    // Photo recommendations
    if (gaps.missingPhotos > 0) {
      const priority = gaps.missingPhotos > 50 ? 'high' : 'medium';
      recommendations.push({
        priority,
        action: `Generate ${gaps.missingPhotos} product photos using AI`,
        estimatedCost: gaps.missingPhotos * 0.05,
        estimatedTime: `${Math.ceil(gaps.missingPhotos / 10)} hours`,
      });
    }

    // Description recommendations
    if (gaps.missingDescriptions > 0) {
      const priority = gaps.missingDescriptions > 100 ? 'high' : 'medium';
      recommendations.push({
        priority,
        action: `Generate ${gaps.missingDescriptions} product descriptions`,
        estimatedCost: gaps.missingDescriptions * 0.02,
        estimatedTime: `${Math.ceil(gaps.missingDescriptions / 50)} hours`,
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
}
