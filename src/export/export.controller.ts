import { Controller, Post, Get, Body, Param, Query, UseGuards, Request } from '@nestjs/common';
import { ExportService, ExportJobData } from './export.service';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';

@Controller('export')
@UseGuards(SupabaseAuthGuard)
export class ExportController {
  constructor(private readonly exportService: ExportService) {}

  @Post('jobs')
  async createExportJob(@Request() req: any, @Body() jobData: ExportJobData) {
    const userId = req.user.id;
    return this.exportService.createExportJob(userId, jobData);
  }

  @Get('jobs')
  async getUserExportJobs(@Request() req: any, @Query('limit') limit?: string) {
    const userId = req.user.id;
    const parsedLimit = limit ? parseInt(limit, 10) : 20;
    return this.exportService.getUserExportJobs(userId, parsedLimit);
  }

  @Get('jobs/:jobId')
  async getExportJobStatus(@Request() req: any, @Param('jobId') jobId: string) {
    const userId = req.user.id;
    return this.exportService.getExportJobStatus(userId, jobId);
  }
}






