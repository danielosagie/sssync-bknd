import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config'; // For CloverApiClient if it uses ConfigService directly
import { CommonModule } from '../../common/common.module'; // For EncryptionService if needed by ApiClient
import { PlatformConnectionsModule } from '../../platform-connections/platform-connections.module'; // For PlatformConnectionsService
import { CanonicalDataModule } from '../../canonical-data/canonical-data.module';
import { PlatformProductMappingsModule } from '../../platform-product-mappings/platform-product-mappings.module';
import { CloverApiClient } from './clover-api-client.service';
import { CloverMapper } from './clover.mapper';
import { CloverAdapter } from './clover.adapter';

@Module({
  imports: [
    ConfigModule,       // If CloverApiClient directly uses ConfigService for API keys/URLs
    CommonModule,       // If CloverApiClient or other services here need EncryptionService
    PlatformConnectionsModule, // CloverApiClient uses PlatformConnectionsService for tokens
    CanonicalDataModule,
    PlatformProductMappingsModule,
  ],
  providers: [
    CloverApiClient,
    CloverMapper,
    CloverAdapter,
  ],
  exports: [CloverAdapter], // Export the main adapter facade
})
export class CloverAdapterModule {} 