import { Controller, Post, UseGuards, UploadedFile, UseInterceptors, Body, HttpCode, HttpStatus, Logger } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IngestService } from './ingest.service';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';

@Controller('ingest')
@UseGuards(SupabaseAuthGuard)
export class IngestController {
  private readonly logger = new Logger(IngestController.name);

  constructor(private readonly ingestService: IngestService) {}

  @Post('csv')
  @UseInterceptors(FileInterceptor('file'))
  @HttpCode(HttpStatus.ACCEPTED)
  async ingestCsv(
    @UploadedFile() file: any,
    @Body('jobId') jobId: string,
    @Body() body: any,
  ): Promise<{ message: string; count: number; jobId: string }> {
    const userId = (body?.user?.id) || body?.userId; // guard should attach req.user in actual app
    // Fallback: let client pass userId if guard injection isn't wired here
    const csvText = file?.buffer ? file.buffer.toString('utf8') : (file as any)?.text;
    const filename = file?.originalname || 'upload.csv';
    const ingestJobId = jobId || `csv-${Date.now()}`;

    const res = await this.ingestService.ingestCsv(userId, filename, csvText, ingestJobId);
    // TODO: enqueue a match job for newly inserted RawImportItems by jobId
    return { message: 'Ingest accepted', count: res.count, jobId: ingestJobId };
  }
}


