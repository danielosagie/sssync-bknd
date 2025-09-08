import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Groq from 'groq-sdk';

export interface SmartPickerCandidate {
  id: string;
  title: string;
  description?: string;
  imageUrl?: string;
  vectorScore: number;
  metadata?: any;
}

export interface SmartPickerRequest {
  targetImage: string; // URL of target image
  ocrText?: string; // OCR extracted text from target
  candidates: SmartPickerCandidate[];
  maxCandidates?: number; // Default: 10
  userId?: string;
}

export interface SmartPickerResult {
  selectedCandidate: SmartPickerCandidate;
  confidence: number; // 0-1 score
  reasoning: string; // Explanation of why this was chosen
  alternativeOptions?: SmartPickerCandidate[]; // Top 2-3 alternatives
  processingTimeMs: number;
}

@Injectable()
export class GroqSmartPickerService {
  private readonly logger = new Logger(GroqSmartPickerService.name);
  private readonly groqClient: Groq | null;

  constructor(private readonly configService: ConfigService) {
    const groqApiKey = this.configService.get<string>('GROQ_API_KEY');
    
    if (!groqApiKey) {
      this.logger.warn('GROQ_API_KEY not configured - smart picker will be disabled');
      this.groqClient = null;
    } else {
      this.groqClient = new Groq({ apiKey: groqApiKey });
      this.logger.log('Groq Smart Picker service initialized');
    }
  }

  /**
   * 🎯 Use Groq Llama-4 to intelligently pick the best match from candidates
   */
  async pickBestMatch(request: SmartPickerRequest): Promise<SmartPickerResult> {
    const startTime = Date.now();
    
    if (!this.groqClient) {
      throw new Error('Groq API not configured');
    }

    const { targetImage, ocrText, candidates } = request;
    const maxCandidates = Math.min(request.maxCandidates || 10, candidates.length);
    const topCandidates = candidates.slice(0, maxCandidates);

    this.logger.log(`[SmartPicker] Analyzing ${topCandidates.length} candidates with ${ocrText ? 'OCR' : 'no OCR'} data`);

    try {
      // Build the prompt with OCR context and candidate options
      const prompt = this.buildAnalysisPrompt(ocrText, topCandidates);

      // Download target image as base64 for vision analysis
      const targetImageBase64 = await this.downloadImageAsBase64(targetImage);

      // Call Groq Llama-4 with vision
      const response = await this.groqClient.chat.completions.create({
        model: "llama-3.2-90b-vision-preview", // Use vision model
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: prompt
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${targetImageBase64}`
                }
              }
            ]
          }
        ],
        temperature: 0.1, // Low temperature for consistent analysis
        max_tokens: 1000
      });

      const analysisResult = response.choices[0]?.message?.content;
      if (!analysisResult) {
        throw new Error('No analysis result from Groq');
      }

      this.logger.debug(`[SmartPicker] Raw Groq response: ${analysisResult.substring(0, 200)}...`);

      // Parse the structured response
      const result = this.parseGroqResponse(analysisResult, topCandidates);
      const processingTime = Date.now() - startTime;

      this.logger.log(`[SmartPicker] Selected candidate "${result.selectedCandidate.title}" with ${result.confidence} confidence in ${processingTime}ms`);

      return {
        ...result,
        processingTimeMs: processingTime
      };

    } catch (error) {
      this.logger.error(`[SmartPicker] Analysis failed: ${error.message}`);
      
      // Fallback: return highest vector score candidate
      const fallbackCandidate = topCandidates[0];
      return {
        selectedCandidate: fallbackCandidate,
        confidence: 0.1, // Low confidence for fallback
        reasoning: `Fallback selection: highest vector similarity (${fallbackCandidate.vectorScore.toFixed(3)}). AI analysis failed: ${error.message}`,
        processingTimeMs: Date.now() - startTime
      };
    }
  }

  /**
   * Build analysis prompt for Groq with OCR context and candidates
   */
  private buildAnalysisPrompt(ocrText: string | undefined, candidates: SmartPickerCandidate[]): string {
    let prompt = `You are a product matching expert. Look at the target image and help me find the EXACT matching product from the candidate list.

TARGET IMAGE ANALYSIS:
- Examine the image carefully for product details, text, branding, colors, and unique features`;

    if (ocrText) {
      prompt += `
- OCR EXTRACTED TEXT: "${ocrText}"
- Use this text to identify the specific product name, model, or key details`;
    }

    prompt += `

CANDIDATE OPTIONS:
`;

    candidates.forEach((candidate, index) => {
      prompt += `${index + 1}. "${candidate.title}"
   - Vector Similarity: ${candidate.vectorScore.toFixed(3)}
   - Description: ${candidate.description || 'No description'}
   ${candidate.imageUrl ? `- Image: ${candidate.imageUrl}` : '- No image available'}

`;
    });

    prompt += `
TASK:
1. Analyze the target image for key identifying features
2. Compare with the candidate titles and descriptions
3. Find the EXACT match, not just similar products
4. Consider OCR text as primary identification source
5. Respond in this EXACT format:

SELECTED: [number]
CONFIDENCE: [0.0-1.0]
REASONING: [Brief explanation why this is the exact match]
ALTERNATIVES: [2-3 other candidate numbers that could be considered]

Example response:
SELECTED: 3
CONFIDENCE: 0.92
REASONING: OCR text "Charizard V Basic HP 220" exactly matches candidate 3's title which contains "Charizard V Basic". The card layout and text positioning in the image confirms this is the same Pokemon card.
ALTERNATIVES: 5, 7

IMPORTANT:
- Only select if you're confident it's the SAME product (not just similar)
- Use OCR text as the primary matching criterion
- Lower confidence if unsure rather than guessing
- Consider product variants carefully (different sets, conditions, etc.)`;

    return prompt;
  }

  /**
   * Parse Groq's structured response into result object
   */
  private parseGroqResponse(response: string, candidates: SmartPickerCandidate[]): Omit<SmartPickerResult, 'processingTimeMs'> {
    try {
      // Extract structured data using regex
      const selectedMatch = response.match(/SELECTED:\s*(\d+)/i);
      const confidenceMatch = response.match(/CONFIDENCE:\s*([\d.]+)/i);
      const reasoningMatch = response.match(/REASONING:\s*(.+?)(?=\nALTERNATIVES:|$)/is);
      const alternativesMatch = response.match(/ALTERNATIVES:\s*(.+)/i);

      if (!selectedMatch || !confidenceMatch || !reasoningMatch) {
        throw new Error('Could not parse structured response from Groq');
      }

      const selectedIndex = parseInt(selectedMatch[1]) - 1; // Convert to 0-based index
      const confidence = Math.max(0, Math.min(1, parseFloat(confidenceMatch[1])));
      const reasoning = reasoningMatch[1].trim();

      if (selectedIndex < 0 || selectedIndex >= candidates.length) {
        throw new Error(`Invalid selected index: ${selectedIndex + 1}`);
      }

      const selectedCandidate = candidates[selectedIndex];

      // Parse alternatives
      let alternativeOptions: SmartPickerCandidate[] = [];
      if (alternativesMatch) {
        const altIndices = alternativesMatch[1]
          .split(',')
          .map(s => parseInt(s.trim()) - 1)
          .filter(i => i >= 0 && i < candidates.length && i !== selectedIndex)
          .slice(0, 3); // Max 3 alternatives

        alternativeOptions = altIndices.map(i => candidates[i]);
      }

      return {
        selectedCandidate,
        confidence,
        reasoning,
        alternativeOptions
      };

    } catch (error) {
      this.logger.warn(`[SmartPicker] Failed to parse structured response: ${error.message}`);
      this.logger.debug(`[SmartPicker] Raw response: ${response}`);
      
      // Fallback: try to extract just the selected number
      const numberMatch = response.match(/\b(\d+)\b/);
      if (numberMatch) {
        const selectedIndex = parseInt(numberMatch[1]) - 1;
        if (selectedIndex >= 0 && selectedIndex < candidates.length) {
          return {
            selectedCandidate: candidates[selectedIndex],
            confidence: 0.3, // Low confidence for fallback parsing
            reasoning: `Partial parsing: Selected candidate ${selectedIndex + 1}. ${response.substring(0, 100)}...`,
            alternativeOptions: candidates.slice(0, 3).filter((_, i) => i !== selectedIndex)
          };
        }
      }

      // Final fallback: return first candidate
      return {
        selectedCandidate: candidates[0],
        confidence: 0.1,
        reasoning: `Parsing failed. Defaulted to highest vector similarity. Response: ${response.substring(0, 100)}...`,
        alternativeOptions: candidates.slice(1, 4)
      };
    }
  }

  /**
   * Download image and convert to base64 for Groq vision API
   */
  private async downloadImageAsBase64(imageUrl: string): Promise<string> {
    try {
      this.logger.debug(`[SmartPicker] Downloading image: ${imageUrl}`);
      
      const response = await fetch(imageUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; smart-picker/1.0)',
        },
      });
      
      if (!response.ok) {
        throw new Error(`Failed to download image: ${response.statusText}`);
      }
      
      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      
      this.logger.debug(`[SmartPicker] Downloaded image: ${(buffer.byteLength / 1024).toFixed(1)}KB`);
      return base64;
      
    } catch (error) {
      this.logger.error(`[SmartPicker] Failed to download image ${imageUrl}: ${error.message}`);
      throw error;
    }
  }
}
