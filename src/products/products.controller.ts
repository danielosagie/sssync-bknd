// src/products/products.controller.ts
import { Controller, Post, Body, Query, UsePipes, ValidationPipe, Logger, BadRequestException, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import { ProductsService } from './products.service';
import { AnalyzeImagesDto } from './dto/analyze-images.dto';
import { GenerateDetailsDto } from './dto/generate-details.dto';
import { SerpApiLensResponse } from './image-recognition/image-recognition.service';
import { GeneratedDetails } from './ai-generation/ai-generation.service';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

// Define simple types if DTOs are not ready yet
interface SimpleProduct { Id: string; UserId: string; /*...*/ }
interface SimpleProductVariant { Id: string; ProductId: string; /*...*/ }
interface SimpleAiGeneratedContent { Id: string; ProductId: string; /*...*/ }

@Controller('products')
export class ProductsController {
    private readonly logger = new Logger(ProductsController.name);

    constructor(private readonly productsService: ProductsService) {}

    /**
     * Endpoint 1 (Revised): Analyzes images, creates draft, saves analysis.
     */
    @Post('analyze')
    @Throttle({ default: { limit: 10, ttl: 60000 }})
    @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    @HttpCode(HttpStatus.OK)
    async analyzeAndCreateDraft(
        @Body() analyzeImagesDto: AnalyzeImagesDto,
        @Query('userId') userId: string,
    ): Promise<{ product: SimpleProduct; variant: SimpleProductVariant; analysis?: SimpleAiGeneratedContent }> {
        this.logger.log(`Analyze images request for user: ${userId}`);
         if (!userId) {
             throw new BadRequestException('Temporary: userId query parameter is required.');
         }
         if (!analyzeImagesDto || !analyzeImagesDto.imageUris || analyzeImagesDto.imageUris.length === 0) {
            throw new BadRequestException('At least one image URI is required in the request body.');
         }

        // Pass the primary image URI to the service for analysis
        // The service currently only takes one imageUrl for SerpApi
        const primaryImageUrl = analyzeImagesDto.imageUris[0];

        // Pass any initial data from the DTO to the service if needed
        // The service expects an optional object like { title, description, price, sku }
        const initialData = {
            // Map fields from analyzeImagesDto if they exist, e.g.:
            // title: analyzeImagesDto.initialTitle,
            // sku: analyzeImagesDto.initialSku,
        };

        // Directly return the result from the service, as its type now matches the declaration
        return this.productsService.analyzeAndCreateDraft(
            userId,
            primaryImageUrl,
            initialData,
        );
    }

    /**
     * Endpoint 2 (Revised): Generates AI details for an existing draft product/variant.
     */
    @Post('generate-details')
    @Throttle({ default: { limit: 5, ttl: 60000 }})
    @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    async generateDetailsForDraft(
         @Body() generateDetailsDto: GenerateDetailsDto,
         @Query('userId') userId: string,
    ): Promise<{ generatedDetails: GeneratedDetails | null }> {
         this.logger.log(`Generate details request for user: ${userId}, product: ${generateDetailsDto.productId}, variant: ${generateDetailsDto.variantId}`);
         if (!userId) {
             throw new BadRequestException('Temporary: userId query parameter is required.');
         }
         if (!generateDetailsDto.productId || !generateDetailsDto.variantId) {
             throw new BadRequestException('productId and variantId are required in the request body.');
         }
         if (generateDetailsDto.coverImageIndex >= generateDetailsDto.imageUris.length) {
             throw new BadRequestException('coverImageIndex is out of bounds for the provided imageUris array.');
         }

         return this.productsService.generateDetailsForDraft(
            userId,
            generateDetailsDto.productId,
            generateDetailsDto.variantId,
            generateDetailsDto.imageUris,
            generateDetailsDto.coverImageIndex,
            generateDetailsDto.selectedPlatforms,
            generateDetailsDto.selectedMatch,
         );
    }

    // ... (TODO endpoints) ...
}