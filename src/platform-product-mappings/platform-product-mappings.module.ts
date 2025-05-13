import { Module } from '@nestjs/common';
import { PlatformProductMappingsService } from './platform-product-mappings.service';
import { CommonModule } from '../common/common.module';

@Module({
    imports: [CommonModule],
    providers: [PlatformProductMappingsService],
    exports: [PlatformProductMappingsService],
})
export class PlatformProductMappingsModule {} 