import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module'; // Needs SupabaseService
import { ProductsService } from './products.service';
import { InventoryService } from './inventory.service';

@Module({
  imports: [CommonModule], // Import CommonModule to make SupabaseService available
  providers: [
      ProductsService,
      InventoryService
    ],
  exports: [
      ProductsService,
      InventoryService
    ], // Export services for other modules to use
})
export class CanonicalDataModule {} 