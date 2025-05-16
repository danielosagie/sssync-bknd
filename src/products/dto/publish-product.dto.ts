import {
  IsString,
  IsUUID,
  IsNotEmpty,
  IsEnum,
  IsObject,
  ValidateNested,
  IsOptional,
  IsArray,
  IsNumber,
  Min,
  IsDefined,
  Length,
  Matches
} from 'class-validator';
import { Type } from 'class-transformer';

// Define a specific DTO for the canonical details
class CanonicalPlatformDetailDto {
  @IsString({ message: 'Canonical title must be a string.' })
  @IsNotEmpty({ message: 'Canonical title is required and cannot be empty.' })
  @Length(1, 255, { message: 'Canonical title must be between 1 and 255 characters.'})
  title: string;

  @IsString({ message: 'Canonical SKU must be a string.' })
  @IsNotEmpty({ message: 'Canonical SKU is required and cannot be empty.' })
  @Length(1, 100, { message: 'Canonical SKU must be between 1 and 100 characters.'})
  // Example: SKUs typically shouldn't have spaces, could add @Matches(/^[A-Za-z0-9_-]*$/, { message: 'SKU can only contain letters, numbers, underscores, and hyphens.' })
  sku: string;

  @IsNumber({}, { message: 'Canonical price must be a number.' })
  @Min(0, { message: 'Canonical price cannot be negative.' }) // Allow 0 for free items if applicable
  @IsDefined({ message: 'Canonical price is required.' }) // Use IsDefined because IsNotEmpty doesn't work well for 0
  price: number;

  @IsString({ message: 'Canonical description must be a string.' })
  @IsOptional()
  description?: string;

  @IsNumber({}, { message: 'Canonical compareAtPrice must be a number.' })
  @Min(0, { message: 'Canonical compareAtPrice cannot be negative.' })
  @IsOptional()
  compareAtPrice?: number;

  @IsString({ message: 'Canonical barcode must be a string.' })
  @IsOptional()
  @Length(1, 100, { message: 'Barcode must be between 1 and 100 characters.'})
  barcode?: string;
  
  @IsNumber({}, { message: 'Canonical weight must be a number.' })
  @Min(0, { message: 'Canonical weight cannot be negative.' })
  @IsOptional()
  weight?: number;

  @IsString({ message: 'Canonical weightUnit must be a string.' })
  @IsOptional()
  // Could add @IsEnum if you have a fixed list of weight units
  weightUnit?: string;

  @IsArray({ message: 'Canonical tags must be an array of strings.' })
  @IsString({ each: true, message: 'Each tag must be a string.' })
  @IsOptional()
  tags?: string[];

  @IsString({ message: 'Canonical vendor must be a string.' })
  @IsOptional()
  vendor?: string;
  
  @IsString({ message: 'Canonical productType must be a string.' })
  @IsOptional()
  productType?: string;

  @IsString({ message: 'Canonical status must be a string.' }) // Or use IsEnum(['active', 'draft', 'archived'])
  @IsOptional()
  status?: string; 
  
  @IsString({ message: 'Canonical brand must be a string.' })
  @IsOptional()
  brand?: string;
  
  @IsString({ message: 'Canonical condition must be a string.' })
  @IsOptional()
  condition?: string;

  @IsString({message: 'Canonical categorySuggestion must be a string.'})
  @IsOptional()
  categorySuggestion?: string;
}


// Define platform-specific data structures (can be refined)
// This remains generic for other platforms, or you can create specific DTOs for them too.
class OtherPlatformDetailDto {
  [key: string]: any; // Allow flexible fields for now
}

class MediaDto {
  @IsArray()
  // @IsUrl({}, { each: true }) // Temporarily removed strict URL validation
  @IsString({ each: true, message: 'Each image URI must be a string.' }) 
  @IsNotEmpty({ message: 'imageUris array cannot be empty if media object is provided.'}) // if media is mandatory
  imageUris: string[];

  @IsNumber({}, { message: 'coverImageIndex must be a number.'})
  @Min(0, { message: 'coverImageIndex cannot be negative.'})
  @IsDefined({ message: 'coverImageIndex is required.'})
  coverImageIndex: number;
}

export enum PublishIntent {
  SAVE_SSSYNC_DRAFT = 'SAVE_SSSYNC_DRAFT',
  PUBLISH_PLATFORM_DRAFT = 'PUBLISH_PLATFORM_DRAFT',
  PUBLISH_PLATFORM_LIVE = 'PUBLISH_PLATFORM_LIVE',
}

export class PublishProductDto {
  @IsUUID()
  @IsNotEmpty({ message: 'productId is required.' })
  productId: string;

  @IsUUID()
  @IsNotEmpty({ message: 'variantId is required.' })
  variantId: string;

  @IsEnum(PublishIntent, { message: 'Invalid publishIntent value.' })
  @IsNotEmpty({ message: 'publishIntent is required.' })
  publishIntent: PublishIntent;

  @IsObject({ message: 'platformDetails must be an object.' })
  @ValidateNested() // This will validate the nested DTOs
  @IsDefined({ message: 'platformDetails is required and must contain a canonical key.'}) // Ensures platformDetails itself exists
  @Type(() => PlatformDetailsContainerDto) // Helper DTO for transformation
  platformDetails: PlatformDetailsContainerDto;


  @IsObject({ message: 'media must be an object.' })
  @ValidateNested()
  @Type(() => MediaDto)
  @IsDefined({ message: 'media object is required.' }) // Make media object itself required
  media: MediaDto;

  @IsArray({ message: 'selectedPlatformsToPublish must be an array of strings.' })
  @IsString({ each: true, message: 'Each platform in selectedPlatformsToPublish must be a string.'})
  @IsOptional() // Publishing to platforms is optional on this call
  selectedPlatformsToPublish?: string[] | null; // Allow null as per API doc
}

// Helper DTO for Type transformation due to mixed types in platformDetails
class PlatformDetailsContainerDto {
  @ValidateNested()
  @Type(() => CanonicalPlatformDetailDto)
  @IsDefined({ message: 'platformDetails.canonical is required.'})
  canonical: CanonicalPlatformDetailDto;

  // For other dynamic keys like 'shopify', 'square'
  // No direct validation here with class-validator for dynamic keys,
  // but Type(() => OtherPlatformDetailDto) would apply if you had a fixed list
  // or a more complex setup. For truly dynamic keys, NestJS validation is limited.
  // The controller/service might need to do additional checks if necessary.
  [platformSlug: string]: CanonicalPlatformDetailDto | OtherPlatformDetailDto;
}
