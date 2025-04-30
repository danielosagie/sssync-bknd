import {
  IsString,
  IsUUID,
  IsNotEmpty,
  IsEnum,
  IsObject,
  ValidateNested,
  IsOptional,
  IsArray,
  IsUrl,
  IsNumber,
  Min,
  IsDefined,
} from 'class-validator';
import { Type } from 'class-transformer';

// Define platform-specific data structures (can be refined)
class PlatformDetailDto {
  [key: string]: any; // Allow flexible fields for now
}

class MediaDto {
  @IsArray()
  @IsUrl({}, { each: true })
  imageUrls: string[];

  @IsNumber()
  @Min(0)
  @IsDefined()
  coverImageIndex: number;
}

export enum PublishIntent {
  SAVE_SSSYNC_DRAFT = 'SAVE_SSSYNC_DRAFT',
  PUBLISH_PLATFORM_DRAFT = 'PUBLISH_PLATFORM_DRAFT',
  PUBLISH_PLATFORM_LIVE = 'PUBLISH_PLATFORM_LIVE',
}

export class PublishProductDto {
  @IsUUID()
  @IsNotEmpty()
  productId: string;

  @IsUUID()
  @IsNotEmpty()
  variantId: string;

  @IsEnum(PublishIntent)
  @IsNotEmpty()
  publishIntent: PublishIntent;

  // Use ValidateNested for nested objects, Type for class transformation
  @IsObject()
  @ValidateNested()
  @Type(() => PlatformDetailDto) // Assumes a generic detail object, refine if needed
  @IsOptional() // Make optional in case only saving draft with no platform data yet? Or require? Let's require for now.
  platformDetails: Record<string, PlatformDetailDto>; // keys: 'shopify', 'square' etc.

  @IsObject()
  @ValidateNested()
  @Type(() => MediaDto)
  @IsNotEmpty()
  media: MediaDto;
}
