import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import * as Tesseract from 'tesseract.js';

export interface OcrResult {
  text: string;
  confidence: number;
  boundingBoxes?: Array<{
    text: string;
    confidence: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  processingTimeMs: number;
}

@Injectable()
export class OcrService {
  private readonly logger = new Logger(OcrService.name);
  private tesseractWorker: Tesseract.Worker | null = null;

  constructor(private readonly configService: ConfigService) {
    this.initializeTesseract();
  }

  private async initializeTesseract() {
    try {
      this.tesseractWorker = await Tesseract.createWorker('eng', 1, {
        logger: m => {
          if (m.status === 'recognizing text') {
            this.logger.debug(`[OCR] Progress: ${Math.round(m.progress * 100)}%`);
          }
        }
      });
      
      // 🎯 OPTIMIZED for Trading Cards: Better accuracy
      await this.tesseractWorker.setParameters({
        tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK, // Single uniform block of text
        tessedit_ocr_engine_mode: Tesseract.OEM.LSTM_ONLY, // Use LSTM neural network
        tessedit_char_blacklist: '|@#$%^&*()_+=[]{}\\<>?/~`', // Remove symbols that cause noise
        preserve_interword_spaces: '1',
        user_defined_dpi: '300', // High DPI for better recognition
        textord_heavy_nr: '1', // Better noise reduction
      });
      
      this.logger.log('[OCR] Tesseract worker initialized successfully');
    } catch (error) {
      this.logger.error('[OCR] Failed to initialize Tesseract:', error.message);
    }
  }

  /**
   * Extract text from image using LOCAL Tesseract OCR
   * 🎯 INSTANT, FREE, HIGH-QUALITY local processing
   */
  async extractTextFromImage(imageData: {
    imageUrl?: string;
    imageBase64?: string;
  }): Promise<OcrResult> {
    const startTime = Date.now();
    
    try {
      if (!this.tesseractWorker) {
        throw new Error('Tesseract worker not initialized');
      }

      let imageBuffer: Buffer;
      
      if (imageData.imageBase64) {
        imageBuffer = Buffer.from(imageData.imageBase64, 'base64');
      } else if (imageData.imageUrl) {
        imageBuffer = await this.downloadImageAsBuffer(imageData.imageUrl);
      } else {
        throw new Error('Either imageUrl or imageBase64 must be provided');
      }

      // 🎯 PREPROCESSING: Enhance image for better OCR
      const enhancedImageBuffer = await this.preprocessImageForOcr(imageBuffer);

      this.logger.log(`[OCR] Processing image locally with Tesseract`);
      
      // 🎯 LOCAL OCR: No network calls, instant processing
      const ocrResult = await this.tesseractWorker.recognize(enhancedImageBuffer);
      
      const processingTime = Date.now() - startTime;

      // Extract bounding boxes for detailed results
      const boundingBoxes = ocrResult.data.words
        .filter(word => word.confidence > 50) // Filter low-confidence words
        .map(word => ({
          text: word.text,
          confidence: word.confidence / 100, // Convert to 0-1 scale
          x: word.bbox.x0,
          y: word.bbox.y0,
          width: word.bbox.x1 - word.bbox.x0,
          height: word.bbox.y1 - word.bbox.y0
        }));

      const result: OcrResult = {
        text: ocrResult.data.text.trim(),
        confidence: ocrResult.data.confidence / 100, // Convert to 0-1 scale
        boundingBoxes,
        processingTimeMs: processingTime
      };

      this.logger.log(`[OCR] ✅ Extracted ${result.text.length} characters in ${processingTime}ms (confidence: ${result.confidence.toFixed(2)})`);
      
      if (result.text.length > 0) {
        this.logger.log(`[OCR] Text: "${result.text.substring(0, 100)}${result.text.length > 100 ? '...' : ''}"`);
      }

      return result;
      
    } catch (error) {
      const processingTime = Date.now() - startTime;
      this.logger.error(`[OCR] Failed to extract text: ${error.message}`);
      
      // Return empty result instead of throwing
      return {
        text: '',
        confidence: 0,
        processingTimeMs: processingTime
      };
    }
  }

  /**
   * 🎯 AGGRESSIVE PREPROCESSING: Make text crystal clear for OCR
   */
  private async preprocessImageForOcr(imageBuffer: Buffer): Promise<Buffer> {
    try {
      // 🎯 MULTI-STAGE PREPROCESSING for trading cards
      return await sharp(imageBuffer)
        // Scale up for better text recognition (bigger = better for OCR)
        .resize({ width: 2000, height: 2800, fit: 'inside', withoutEnlargement: true })
        // Convert to grayscale first
        .grayscale()
        // AGGRESSIVE contrast enhancement
        .linear(1.5, -(128 * 0.5)) // Increase contrast dramatically
        // Normalize to full dynamic range
        .normalize()
        // Heavy sharpening for text clarity
        .sharpen({ sigma: 2.0, x1: 2, y2: 0.5, y3: 4 })
        // Convert to high-contrast black/white if needed
        .threshold(128, { greyscale: false })
        // Final format optimized for OCR
        .png({ quality: 100, compressionLevel: 0, palette: false })
        .toBuffer();
    } catch (error) {
      this.logger.warn(`[OCR] Aggressive preprocessing failed, trying basic: ${error.message}`);
      
      // Fallback to basic preprocessing
      try {
        return await sharp(imageBuffer)
          .resize({ width: 1200, height: 1600, fit: 'inside', withoutEnlargement: true })
          .grayscale()
          .normalize()
          .png()
          .toBuffer();
      } catch (fallbackError) {
        this.logger.warn(`[OCR] Basic preprocessing also failed, using original: ${fallbackError.message}`);
        return imageBuffer;
      }
    }
  }

  /**
   * Extract specific information from card text
   */
  extractCardInfo(ocrText: string): {
    cardName?: string;
    setNumber?: string;
    rarity?: string;
    keywords: string[];
  } {
    const text = ocrText.toLowerCase();
    const keywords: string[] = [];
    
    // Extract card name (usually the first line or largest text)
    const lines = ocrText.split('\n').filter(line => line.trim().length > 0);
    const cardName = lines[0]?.trim();
    
    // Extract set number patterns (e.g., "188/185", "001/198")
    const setNumberMatch = ocrText.match(/(\d{1,3}\/\d{1,3})/);
    const setNumber = setNumberMatch ? setNumberMatch[1] : undefined;
    
    // Extract rarity indicators
    let rarity: string | undefined;
    if (text.includes('secret rare') || text.includes('secret')) {
      rarity = 'Secret Rare';
      keywords.push('secret', 'rare');
    } else if (text.includes('rare holo') || text.includes('holo rare')) {
      rarity = 'Rare Holo';
      keywords.push('rare', 'holo');
    } else if (text.includes('rare')) {
      rarity = 'Rare';
      keywords.push('rare');
    }
    
    // Extract Pokémon-specific terms
    const pokemonTerms = ['pokemon', 'pokémon', 'stage', 'basic', 'evolution', 'hp', 'vmax', 'gx', 'ex'];
    pokemonTerms.forEach(term => {
      if (text.includes(term)) {
        keywords.push(term);
      }
    });
    
    // Extract card numbers, HP values, etc.
    const numbers = ocrText.match(/\b\d+\b/g) || [];
    keywords.push(...numbers);
    
    // Clean and deduplicate keywords
    const cleanKeywords = [...new Set(keywords)]
      .filter(k => k.length > 1)
      .slice(0, 10); // Limit to top 10 keywords
    
    return {
      cardName,
      setNumber,
      rarity,
      keywords: cleanKeywords
    };
  }

  /**
   * Download image and return as Buffer (for local processing)
   */
  private async downloadImageAsBuffer(imageUrl: string): Promise<Buffer> {
    try {
      const response = await fetch(imageUrl);
      if (!response.ok) {
        throw new Error(`Failed to download image: ${response.statusText}`);
      }
      
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
      
    } catch (error) {
      this.logger.error(`Failed to download image from ${imageUrl}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Cleanup Tesseract worker on service destroy
   */
  async onModuleDestroy() {
    if (this.tesseractWorker) {
      await this.tesseractWorker.terminate();
      this.logger.log('[OCR] Tesseract worker terminated');
    }
  }
}
