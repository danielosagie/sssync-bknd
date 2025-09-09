import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Groq from 'groq-sdk';

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
  private readonly groqClient: Groq | null;

  constructor(private readonly configService: ConfigService) {
    const groqApiKey = this.configService.get<string>('GROQ_API_KEY');
    
    if (!groqApiKey) {
      this.logger.warn('[OCR] GROQ_API_KEY not configured. OCR service will be disabled.');
      this.groqClient = null;
    } else {
      this.groqClient = new Groq({
        apiKey: groqApiKey,
      });
      this.logger.log('[OCR] Groq client initialized with Llama-4 Scout for OCR');
    }
  }

  /**
   * Extract text from image using Groq Llama-4 Scout
   * 🎯 VISION-ENABLED: AI can directly read text from images
   */
  async extractTextFromImage(imageData: {
    imageUrl?: string;
    imageBase64?: string;
  }): Promise<OcrResult> {
    const startTime = Date.now();
    
    try {
      if (!this.groqClient) {
        throw new Error('Groq client not initialized - GROQ_API_KEY missing');
      }

      let imageBase64: string;
      
      if (imageData.imageBase64) {
        imageBase64 = imageData.imageBase64;
      } else if (imageData.imageUrl) {
        imageBase64 = await this.downloadImageAsBase64(imageData.imageUrl);
      } else {
        throw new Error('Either imageUrl or imageBase64 must be provided');
      }

      this.logger.log(`[OCR] Processing image with Groq Llama-4 Scout (vision model)`);
      
      // 🎯 LLAMA-4 SCOUT: Direct image-to-text with AI vision
      const completion = await this.groqClient.chat.completions.create({
        model: "meta-llama/llama-4-scout-17b-16e-instruct",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Please extract all visible text from this image. Focus on:
- Product names, titles, brands
- Numbers, prices, model numbers  
- Any descriptors you can understand from this item
- Any printed text or labels
- Card names, set information (if trading cards)
- Description text

Return only the extracted text, preserving the original layout and order as much as possible. If no text is visible, return "NO_TEXT_FOUND".`
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${imageBase64}`
                }
              }
            ]
          }
        ],
        max_tokens: 1000,
        temperature: 0.1, // Low temperature for consistent text extraction
      });
      
      const processingTime = Date.now() - startTime;
      const extractedText = completion.choices[0]?.message?.content?.trim() || '';
      
      // Calculate confidence based on response quality
      let confidence = 0.9; // Default high confidence for Llama-4
      if (extractedText === 'NO_TEXT_FOUND' || extractedText.length === 0) {
        confidence = 0.0;
      } else if (extractedText.length < 10) {
        confidence = 0.6; // Lower confidence for very short text
      }

      const result: OcrResult = {
        text: extractedText,
        confidence,
        processingTimeMs: processingTime
      };

      this.logger.log(`[OCR] ✅ Extracted ${result.text.length} characters in ${processingTime}ms (confidence: ${result.confidence.toFixed(2)})`);
      
      if (result.text.length > 0 && result.text !== 'NO_TEXT_FOUND') {
        this.logger.log(`[OCR] Text: "${result.text.substring(0, 100)}${result.text.length > 100 ? '...' : ''}"`);
      }

      return result;
      
    } catch (error) {
      const processingTime = Date.now() - startTime;
      this.logger.error(`[OCR] Failed to extract text with Groq: ${error.message}`);
      
      // Return empty result instead of throwing
      return {
        text: '',
        confidence: 0,
        processingTimeMs: processingTime
      };
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
   * Download image and return as base64 (for Groq vision API)
   */
  private async downloadImageAsBase64(imageUrl: string): Promise<string> {
    try {
      const response = await fetch(imageUrl);
      if (!response.ok) {
        throw new Error(`Failed to download image: ${response.statusText}`);
      }
      
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      return buffer.toString('base64');
      
    } catch (error) {
      this.logger.error(`Failed to download image from ${imageUrl}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Cleanup resources on service destroy
   */
  async onModuleDestroy() {
    // No resources to clean up for Groq client
    this.logger.log('[OCR] OCR service terminated');
  }
}
