import { IsArray, ArrayNotEmpty, IsString, IsUrl, IsUUID, IsInt, Min, Max, IsOptional, ValidateNested, IsDefined, ValidateIf, IsObject, ArrayMinSize } from 'class-validator';
import { Type } from 'class-transformer'; // Needed for ValidateNested
import { SerpApiLensResponse, VisualMatch } from '../image-recognition/image-recognition.service';

// Define a basic DTO for the visual match object (can be expanded)
class SelectedMatchDto implements Partial<VisualMatch> {
    @IsInt() position: number;
    @IsString() title: string;
    @IsOptional() @IsString() link?: string;
    @IsOptional() @IsString() source?: string;
    // Include other fields if the frontend intends to send them
}

// DTO for VisualMatch (used within SerpApiLensResponseDto)
class VisualMatchDto implements VisualMatch {
    @IsInt() position: number;
    @IsString() title: string;
    @IsOptional() @IsString() link?: string;
    @IsOptional() @IsString() source?: string;
    @IsOptional() @IsString() thumbnail?: string;
    @IsOptional() @IsString() image?: string;
    // Add validation for price, rating etc. if strict validation needed
}

// DTO for search_metadata (used within SerpApiLensResponseDto)
class SearchMetadataDto {
    @IsString() id: string;
    @IsString() status: string;
    @IsString() @IsUrl() google_lens_url: string;
}

// DTO representing the SerpApi response structure for validation
class SerpApiLensResponseDto implements Partial<SerpApiLensResponse> { // Use Partial as not all fields might be present
    @ValidateNested()
    @Type(() => SearchMetadataDto)
    @IsDefined() // search_metadata should usually exist
    search_metadata: SearchMetadataDto;

    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => VisualMatchDto)
    visual_matches?: VisualMatchDto[];
}

// Add enhanced web data interface
export class EnhancedWebDataDto {
  @IsString()
  @IsUrl()
  url: string;

  @IsObject()
  scrapedData: any;

  @IsOptional()
  @IsString()
  analysis?: string;
}

export class GenerateDetailsDto {
  @IsUUID() // ID of the draft product created by /analyze
  productId: string;

  @IsUUID() // ID of the draft variant created by /analyze
  variantId: string;

  // Need image URIs again to pass to AI service
  @IsArray()
  @ArrayNotEmpty()
  @IsUrl({}, { each: true })
  imageUris: string[];

  @IsInt()
  @Min(0)
  coverImageIndex: number;

  @IsArray()
  @IsString({ each: true })
  @ArrayNotEmpty()
  selectedPlatforms: string[];

  // Optional: The specific visual match chosen by the user
  @IsOptional()
  @ValidateNested()
  @Type(() => SelectedMatchDto)
  selectedMatch?: SelectedMatchDto;

  // NEW: Enhanced web data from Firecrawl scraping
  @IsOptional()
  @ValidateNested()
  @Type(() => EnhancedWebDataDto)
  enhancedWebData?: EnhancedWebDataDto;

  // Remove lensResponse - no longer needed here
  // lensResponse?: any;
}

// You might want a DTO for the response too
// export class GenerateDetailsResponseDto { ... }
