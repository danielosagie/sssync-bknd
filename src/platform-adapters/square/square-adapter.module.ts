import { Module } from '@nestjs/common';
import { SquareApiClient } from './square-api-client.service';
import { SquareMapper } from './square.mapper';
import { SquareAdapter } from './square.adapter';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [ConfigModule],
  providers: [SquareApiClient, SquareMapper, SquareAdapter],
  exports: [SquareAdapter],
})
export class SquareAdapterModule {}
