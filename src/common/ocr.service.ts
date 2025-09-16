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

      const prompt1 = `You are an ecommerce visual analyst. Return ONLY compact JSON.\n\nSTRICT FOCUS: Describe the MAIN object centered/in focus. Ignore background/secondary items.\n\nFIELDS (always include all):\n- ocr_text (string) → raw text detected; "" if none\n- brand (string) → only if certain; else ""\n- model (string) → only if certain; else ""\n- year (string) → only if explicitly visible; else ""\n- color (string) → single dominant color (e.g. "black", "silver", "grey", "green")\n- type (string) → high-level category, 2–3 words max (e.g. "water bottle", "wireless earbuds", "dslr camera", "zipper pull", "keychain", "bag charm", "toy")\n- flags (array of strings) → optional issues like ["blurry"], ["cropped"], ["multiple items"]\n- confidence (number 0..1)\n- paraphrases (array of EXACTLY 3 short lowercase queries)\n\nPARAPHRASES POLICY (always output 3):\n1) specific_best_guess (2–6 words)\n   - If confidence ≥ 0.8: brand + type + key attribute (e.g., "apple airpods case").\n   - If confidence < 0.8 or brand uncertain: drop brand; keep specific but generic (e.g., "wireless earbuds case").\n   - No SKUs, punctuation, or filler words.\n2) expanded_synonyms (5–9 words)\n   - Combine synonyms, function, and visible descriptors.\n   - Avoid brand-locking.\n   - Examples: "wireless earbuds charging case bluetooth white", "water bottle thermos flask insulated grey steel", "zipper pull keychain toy bag charm".\n3) generic_category (2–4 words)\n   - Broad class + visible color/material.\n   - Always include, even if brand is certain.\n   - Examples: "grey water bottle", "white earbuds", "character zipper pull".\n\nADDITIONAL RULES:\n- If OCR is weak/empty, infer from shape/materials.\n- Prefer class-level terms when uncertain.\n- Always include the dominant visible color.\n- Only fill brand/model/year when strongly supported by text/logos.\n- If the object is a small character attached to a zipper/bag, include toy-related terms in paraphrases (e.g., "toy", "figurine", "zipper pull", "keychain", "bag charm").\n\nEXAMPLE A (plain grey bottle, no OCR):\n{\n  "ocr_text": "",\n  "brand": "",\n  "model": "",\n  "year": "",\n  "color": "grey",\n  "type": "water bottle",\n  "flags": [],\n  "confidence": 0.6,\n  "paraphrases": [\n    "stainless steel water bottle",\n    "water bottle thermos tumbler insulated grey",\n    "grey water bottle"\n  ]\n}\n\nEXAMPLE B (small character toy on zipper):\n{\n  "ocr_text": "",\n  "brand": "",\n  "model": "",\n  "year": "",\n  "color": "green",\n  "type": "zipper pull",\n  "flags": ["toy", "figurine"],\n  "confidence": 0.5,\n  "paraphrases": [\n    "character zipper pull toy",\n    "zipper pull keychain toy bag charm",\n    "toy zipper pull"\n  ]\n}\n\nOutput ONLY the JSON.`;
      const prompt = `
      You are an ecommerce visual analyst. Return ONLY compact JSON.

STRICT FOCUS:

Always describe the MAIN object that is centered and in focus.

Ignore background, secondary objects, or clutter.

If multiple items are present, select the single most prominent.
Consider novelty and unusual items.
Be prepared for unexpected or uncommon products.
Use contextual information to make educated guesses.
Prioritize generic descriptions when uncertain.
Indicate uncertainty with lower confidence scores.


FIELDS (always include all):

ocr_text (string) → if text is visible, output it raw.

If NO text is visible, instead output a short neutral description of the object (e.g. "grey bottle", "green character toy"). Never leave as "".

brand (string) → only if clearly certain from text/logo; else ""

model (string) → only if clearly certain; else ""

year (string) → only if explicitly visible; else ""

color (string) → single dominant visible color (e.g. "black", "silver", "grey", "green")

type (string) → high-level category, 2–3 words max (e.g. "water bottle", "wireless earbuds", "zipper pull", "keychain", "bag charm", "toy")

flags (array of strings) → optional issues like ["blurry"], ["cropped"], ["multiple items"]; [] if none

confidence (number 0..1) → overall certainty of classification

paraphrases (array of EXACTLY 3 lowercase queries)

PARAPHRASES POLICY (always output 3):

specific_best_guess (2–6 words)

If confidence ≥ 0.8 and brand/model certain → include brand + type + key attribute (e.g. "apple airpods case").

If confidence < 0.8 or brand uncertain → use generic but specific description (e.g. "green character toy", "wireless earbuds case").

Never include SKUs, punctuation, or filler.

expanded_synonyms (5–9 words)

Combine synonyms, functions, and visible descriptors.

Avoid brand-locking unless absolutely certain.

Echo relevant terms from product text metadata if present and consistent with the object (e.g. if metadata contains "toy", include "toy" here).

Examples: "zipper pull keychain toy bag charm", "wireless earbuds charging case bluetooth white", "water bottle thermos flask insulated grey steel".

generic_category (2–4 words)

Broad class + visible color/material.

Always include, even if brand is certain.

Examples: "green toy", "grey water bottle", "black backpack".

INFERENCE RULES:

If OCR returns no text, describe the object instead of leaving it empty.

If product text metadata is available, incorporate useful tokens (like "toy", "figurine", "bag charm") into paraphrases if they match what is visually present.

Use visual cues (shape, material, logo placement) if OCR is weak.

Confidence < 0.7 → safer generic phrasing. Confidence ≥ 0.9 → include brand/model if supported.

Always include the dominant visible color.

Only fill brand/model/year if strongly supported by OCR or distinctive features.

EXAMPLE A (plain grey bottle, no text):
{
"ocr_text": "grey bottle",
"brand": "",
"model": "",
"year": "",
"color": "grey",
"type": "water bottle",
"flags": [],
"confidence": 0.6,
"paraphrases": [
"stainless steel water bottle",
"water bottle thermos tumbler insulated grey",
"grey water bottle"
]
}

EXAMPLE B (small green character figurine toy on zipper, product text also said "toy"):
{
"ocr_text": "green character toy",
"brand": "",
"model": "",
"year": "",
"color": "green",
"type": "zipper pull",
"flags": ["toy", "figurine"],
"confidence": 0.5,
"paraphrases": [
"character zipper pull toy",
"zipper pull keychain toy bag charm",
"green toy"
]
}

Output ONLY the JSON.
      
      `

      const completion = await this.groqClient.chat.completions.create({
        model: 'meta-llama/llama-4-maverick-17b-128e-instruct',
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
