import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { CommonModule } from '../../common/common.module';
import { PlatformConnectionsModule } from '../../platform-connections/platform-connections.module';
import { CanonicalDataModule } from '../../canonical-data/canonical-data.module';
import { PlatformProductMappingsModule } from '../../platform-product-mappings/platform-product-mappings.module';
import { SquareApiClientService } from './square-api-client.service';
import { SquareMapper } from './square.mapper';
import { SquareAdapter } from './square.adapter';

@Module({
  imports: [
    HttpModule,
    ConfigModule,
    CommonModule,
    PlatformConnectionsModule,
    CanonicalDataModule,
    PlatformProductMappingsModule,
  ],
  providers: [
    SquareApiClientService,
    SquareMapper,
    SquareAdapter,
  ],
  exports: [SquareAdapter],
})
export class SquareAdapterModule {}
