// src/products/products.controller.ts
import { Controller, Post, Body, Query, UsePipes, ValidationPipe, Logger, BadRequestException, HttpCode, HttpStatus } from '@nestjs/common';
import { ProductsService } from './products.service';
import { AnalyzeImagesDto } from './dto/analyze-images.dto';
import { GenerateDetailsDto } from './dto/generate-details.dto';
import { SerpApiLensResponse } from './image-recognition/image-recognition.service';
import { GeneratedDetails } from './ai-generation/ai-generation.service';

@Controller('products')
export class ProductsController {
    private readonly logger = new Logger(ProductsController.name);

    constructor(private readonly productsService: ProductsService) {}

    // analyzeImages endpoint remains the same

    /**
     * Endpoint to generate product details using AI.
     * Expects image URLs, cover image index, target platforms,
     * and optionally the full SerpApiLensResponse from the previous step.
     */
    @Post('generate-details')
    @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })) // Enable validation & transformation
    async generateDetails(
         @Body() generateDetailsDto: GenerateDetailsDto,
         @Query('userId') userId: string, // !!! TEMPORARY/INSECURE !!!
    ): Promise<{ productId: string; variantId: string; generatedDetails: GeneratedDetails | null }> {
         this.logger.log(`Generate details request for user: ${userId}`);
         if (!userId) {
             throw new BadRequestException('Temporary: userId query parameter is required.');
         }

         // Validate coverImageIndex against the provided imageUris array length
         if (generateDetailsDto.coverImageIndex >= generateDetailsDto.imageUris.length) {
             throw new BadRequestException('coverImageIndex is out of bounds for the provided imageUris array.');
         }

         // Pass the lensResponse from the DTO to the service
         return this.productsService.generateDetails(
            userId,
            generateDetailsDto.imageUris,
            generateDetailsDto.coverImageIndex,
            generateDetailsDto.selectedPlatforms,
            generateDetailsDto.lensResponse, // Pass the object here
         );
    }

    // ... (TODO endpoints) ...
}