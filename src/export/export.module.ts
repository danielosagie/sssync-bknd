import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CommonModule } from '../common/common.module';
import { CanonicalDataModule } from '../canonical-data/canonical-data.module';
import { PlatformAdaptersModule } from '../platform-adapters/platform-adapters.module';
import { ExportService } from './export.service';
import { ExportController } from './export.controller';
// import { ExportProcessor } from './export.processor'; // TODO: Implement ExportProcessor
import { CsvExportFormatter } from './formatters/csv-export.formatter';
import { ShopifyExportFormatter } from './formatters/shopify-export.formatter';
import { SquareExportFormatter } from './formatters/square-export.formatter';

@Module({
  imports: [
    CommonModule,
    CanonicalDataModule,
    PlatformAdaptersModule,
    BullModule.registerQueue({
      name: 'export-jobs',
    }),
  ],
  providers: [
    ExportService,
    // ExportProcessor, // TODO: Implement ExportProcessor
    CsvExportFormatter,
    ShopifyExportFormatter,
    SquareExportFormatter,
  ],
  controllers: [ExportController],
  exports: [ExportService],
})
export class ExportModule {}
