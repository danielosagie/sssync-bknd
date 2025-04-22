import { IsArray, ArrayNotEmpty, IsString, IsUrl, IsUUID, ArrayMinSize } from 'class-validator';

export class AnalyzeImagesDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMinSize(1)
  @IsUrl({}, { each: true }) // Validate each item is a URL
  imageUris: string[];

  @IsArray()
  @IsString({ each: true })
  @ArrayNotEmpty()
  selectedPlatforms: string[]; // e.g., ['shopify', 'amazon']

  // Add userId validation if you implement JWT auth later
  // For now, we'll handle it in the controller from the query param
  // @IsUUID()
  // userId: string;
}

// You might want a DTO for the response too, matching SerpApiLensResponse structure
// export class AnalyzeImagesResponseDto { ... }
