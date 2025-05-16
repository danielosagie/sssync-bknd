import { IsString, IsNotEmpty, Length } from 'class-validator';

export class SkuCheckDto {
  @IsString({ message: 'SKU must be a string.' })
  @IsNotEmpty({ message: 'SKU query parameter is required and cannot be empty.' })
  @Length(1, 100, { message: 'SKU must be between 1 and 100 characters.' })
  sku: string;
} 