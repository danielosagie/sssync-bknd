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
   * Analyze image and return structured attributes + paraphrases using Groq VLM
   * Returns: { ocrText, brand, model, year, color, type, flags[], confidence, paraphrases[] }
   */
  async analyzeImageAttributes(imageData: { imageUrl?: string; imageBase64?: string; }): Promise<{
    ocrText: string;
    brand: string;
    model: string;
    year: string;
    color: string;
    type: string;
    flags: string[];
    confidence: number;
    paraphrases: string[];
    processingTimeMs: number;
  }> {
    const start = Date.now();
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

      const prompt = `

You are an ecommerce visual analyst. Your job is to return ONLY compact JSON that captures what is visible in the image. Do not add explanations or extra text

FIELDS (always include all):

* ocr\_text (string) → raw text detected in the image; if none, ""
* brand (string) → inferred from OCR or clear logos; "" if unclear
* model (string) → inferred from OCR or design cues; "" if unclear
* year (string) → production/release year if explicitly visible; "" otherwise
* color (string) → single plain descriptive color (e.g. "black", "silver", "red", "navy blue")
* type (string) → high-level product category (2–3 words max, e.g. "water bottle", "wireless earbuds", "dslr camera")
* flags (array of strings) → optional issues/conditions, use \[] if none. Examples: \["blurry"], \["cropped"], \["multiple items"], \["occluded"], \["handwritten text"].
* confidence (number, 0..1) → overall certainty of classification and fields
* paraphrases (array of EXACTLY 3 strings) → short lowercase search queries, built by strict rules below

PARAPHRASES POLICY (must always output 3):

1. specific\_best\_guess (2–6 words)

   * If confidence >= 0.8: include brand + product type + key visual attribute. Example: "apple airpods case", "nike running shoes black".
   * If confidence < 0.8 or brand is uncertain: drop the brand, use generic but specific guess. Example: "wireless earbuds case", "stainless steel tumbler".
   * Never use SKUs, punctuation, or filler words.
2. expanded\_synonyms (5–9 words)

   * Combine synonyms, functional attributes, and visible descriptors.
   * Do not brand-lock unless the brand is guaranteed.
   * Example: "wireless earbuds charging case bluetooth white", "water bottle thermos flask insulated grey steel".
3. generic\_category (2–4 words)

   * Broad category + visible color/material.
   * Must always be included, even if brand is certain.
   * Example: "grey water bottle", "white earbuds", "black backpack".

ADDITIONAL RULES:

* If OCR is weak or empty, infer from shape, materials, ports, and logos.
* Prefer general class-level descriptions when uncertain.
* Always describe the **dominant visible color**.
* Only fill brand/model/year when strongly supported by text or distinctive features.
* Confidence < 0.7 means high uncertainty → default to safe, generic guesses.
* Confidence ≥ 0.9 means highly confident → include brand/model details if available.

EXAMPLE (plain grey bottle with stickers, no OCR text):
{
ocr\_text: "",
brand: "",
model: "",
year: "",
color: "grey",
type": water bottle",
flags: \[],
confidence: 0.6,
paraphrases: \[
"stainless steel water bottle",
"water bottle thermos tumbler insulated grey",
"grey water bottle"
]
}

Output ONLY the JSON.`;
      const prompt1 = `You are an ecommerce visual analyst. Return ONLY compact JSON.\n\nRequired fields:\n- ocr_text (string)\n- brand (string)\n- model (string)\n- year (string)\n- color (string)\n- type (string)  // high-level object category like \'water bottle\', \'wireless earbuds\', \'camera\'\n- flags (array of strings)\n- confidence (number 0..1)\n- paraphrases (array of EXACTLY 3 short lowercase search queries)\n\nParaphrases policy (always produce 3 even if unsure):\n1) specific_best_guess: 2-6 words. If confidence >= 0.8 include brand + product type + key attribute (e.g., \'apple airpods case\'). If brand is uncertain, omit brand and keep generic. No SKUs, no punctuation.\n2) expanded_synonyms: 5-9 words combining likely synonyms and attributes, space-separated tokens (e.g., \'wireless earbuds charging case white bluetooth\', \'insulated water bottle stainless steel grey\'). Avoid brand locking here.\n3) generic_category: 2-4 words for broad class + visible color/material (e.g., \'grey water bottle\', \'white wireless earbuds\'). ALWAYS include this even if you know the brand.\n\nIf OCR is missing/weak, infer from visuals (shape, color, materials, ports). Prefer class-level terms when confidence < 0.8 to avoid over-specific filters.\n\nExample (no text, plain grey bottle with stickers):\n{\n  \'ocr_text\': \'\',\n  \'brand\': \'\',\n  \'model\': \'\',\n  \'year\': \'\',\n  \'color\': \'grey\',\n  \'type\': \'water bottle\',\n  \'flags\': [],\n  \'confidence\': 0.6,\n  \'paraphrases\': [\n    \'stainless steel water bottle\',\n    \'water bottle thermos tumbler insulated grey\',\n    \'grey water bottle\'\n  ]\n}\n\nOutput ONLY the JSON.`;

      const completion = await this.groqClient.chat.completions.create({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
            ],
          },
        ],
        max_tokens: 600,
        temperature: 0.2,
      });

      const raw = completion.choices?.[0]?.message?.content?.trim() || '{}';
      let parsed: any = {};
      try {
        // Try to isolate JSON block if the model added text
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
      } catch (e) {
        this.logger.warn(`[VLM] Failed to parse JSON response, returning minimal fields. Raw: ${raw.substring(0, 200)}`);
        parsed = {};
      }

      const ocrText: string = parsed.ocr_text || parsed.ocrText || '';
      const paraphrases: string[] = Array.isArray(parsed.paraphrases) ? parsed.paraphrases.filter((s: any) => typeof s === 'string') : [];
      const confidence: number = typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : (ocrText ? 0.7 : 0.0);

      const result = {
        ocrText,
        brand: parsed.brand || '',
        model: parsed.model || '',
        year: parsed.year || '',
        color: parsed.color || '',
        type: parsed.type || '',
        flags: Array.isArray(parsed.flags) ? parsed.flags.map((x: any) => String(x)) : [],
        confidence,
        paraphrases,
        processingTimeMs: Date.now() - start,
      };

      this.logger.log(`[VLM] ✅ Attributes extracted in ${result.processingTimeMs}ms (conf: ${result.confidence.toFixed(2)}) paraphrases: ${result.paraphrases.slice(0, 3).join(' | ')}`);
      if (result.ocrText) this.logger.log(`[VLM] OCR text (first 100): "${result.ocrText.substring(0, 100)}${result.ocrText.length > 100 ? '...' : ''}"`);

      return result;
    } catch (err) {
      const processingTimeMs = Date.now() - start;
      this.logger.error(`[VLM] Attribute extraction failed: ${err.message}`);
      return {
        ocrText: '',
        brand: '',
        model: '',
        year: '',
        color: '',
        type: '',
        flags: [],
        confidence: 0,
        paraphrases: [],
        processingTimeMs,
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
