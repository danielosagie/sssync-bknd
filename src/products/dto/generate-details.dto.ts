import { IsArray, ArrayNotEmpty, IsString, IsUrl, IsUUID, IsInt, Min, Max, IsOptional, ValidateNested, IsDefined, ValidateIf, IsObject, ArrayMinSize } from 'class-validator';
import { Type } from 'class-transformer'; // Needed for ValidateNested
import { SerpApiLensResponse, VisualMatch } from '../image-recognition/image-recognition.service';

// Define a basic DTO for the visual match object (can be expanded)
class SelectedMatchDto {
    @IsString()
    @IsDefined()
    title: string;

    @IsString()
    @IsOptional()
    link?: string;

    @IsString()
    @IsOptional()
    source?: string;
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

export class GenerateDetailsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMinSize(1)
  @IsUrl({}, { each: true })
  imageUris: string[];

  @IsInt()
  @Min(0)
  coverImageIndex: number;

  @IsArray()
  @IsString({ each: true })
  @ArrayNotEmpty()
  selectedPlatforms: string[];

  // Make selectedMatch optional and validate its structure if present
  @IsOptional()
  @ValidateNested()
  @Type(() => SelectedMatchDto) // Important for nested validation
  selectedMatch?: SelectedMatchDto;

  // Accept the optional SerpApi response object
  @IsOptional()
  @ValidateNested()
  @Type(() => SerpApiLensResponseDto)
  lensResponse?: SerpApiLensResponseDto;

  // Add userId validation if you implement JWT auth later
  // @IsUUID()
  // userId: string;
}

// You might want a DTO for the response too
// export class GenerateDetailsResponseDto { ... }
