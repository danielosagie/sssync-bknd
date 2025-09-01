import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { EmbeddingService } from '../embedding/embedding.service';
import { RerankerService } from '../embedding/reranker.service';

export interface AIServerConfig {
  url: string;
  apiKey: string;
  timeout: number;
  maxRetries: number;
}

export interface AIServerHealth {
  status: string;
  models: Record<string, string>;
  device: string;
  gpu_stats: any;
  uptime: string;
  version: string;
}

export interface AIServerEmbeddingRequest {
  image_data?: string;
  texts?: string[];
  instruction?: string;
  normalize?: boolean;
}

export interface AIServerEmbeddingResponse {
  embeddings: number[][];
  dimension: number;
  model: string;
  usage: any;
  processing_time_ms: number;
}

export interface AIServerRerankRequest {
  query: string;
  candidates: any[];
  top_k?: number;
}

export interface AIServerRerankResponse {
  ranked_candidates: any[];
  scores: number[];
  confidence_tier: string;
  model: string;
  processing_time_ms: number;
}

export interface AIServerTrainingRequest {
  task_type: string;
  data: any;
  parameters?: any;
}

export interface AIServerTrainingResponse {
  task_id: string;
  status: string;
  progress: any;
  estimated_completion?: string;
}

@Injectable()
export class AIServerService {
  private readonly logger = new Logger(AIServerService.name);
  private readonly axiosInstance: AxiosInstance;
  private readonly config: AIServerConfig;
  private isHealthy: boolean = false;
  private lastHealthCheck: Date | null = null;
  private readonly healthCheckInterval = 5 * 60 * 1000; // 5 minutes

  constructor(
    private readonly configService: ConfigService,
    private readonly embeddingService: EmbeddingService,
    private readonly rerankerService: RerankerService,
  ) {
    this.config = {
      url: this.configService.get<string>('AI_SERVER_URL') || 'http://localhost:8000',
      apiKey: this.configService.get<string>('AI_SERVER_API_KEY') || 'your-api-key',
      timeout: parseInt(this.configService.get<string>('AI_SERVER_TIMEOUT') || '300000'),
      maxRetries: parseInt(this.configService.get<string>('AI_SERVER_MAX_RETRIES') || '3'),
    };

    this.axiosInstance = axios.create({
      baseURL: this.config.url,
      timeout: this.config.timeout,
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    // Add request interceptor for logging
    this.axiosInstance.interceptors.request.use(
      (config) => {
        this.logger.debug(`Making request to AI server: ${config.method?.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => {
        this.logger.error('AI server request error:', error);
        return Promise.reject(error);
      }
    );

    // Add response interceptor for logging
    this.axiosInstance.interceptors.response.use(
      (response) => {
        this.logger.debug(`AI server response: ${response.status} ${response.config.url}`);
        return response;
      },
      (error) => {
        this.logger.error('AI server response error:', error.response?.status, error.response?.data);
        return Promise.reject(error);
      }
    );
  }

  /**
   * Check if the AI server is healthy and available
   */
  async checkHealth(): Promise<boolean> {
    try {
      const now = new Date();
      if (this.lastHealthCheck && (now.getTime() - this.lastHealthCheck.getTime()) < this.healthCheckInterval) {
        return this.isHealthy;
      }

      const response: AxiosResponse<AIServerHealth> = await this.axiosInstance.get('/health');
      this.isHealthy = response.data.status === 'healthy';
      this.lastHealthCheck = now;
      
      this.logger.log(`AI server health check: ${this.isHealthy ? 'healthy' : 'unhealthy'}`);
      return this.isHealthy;
    } catch (error) {
      this.isHealthy = false;
      this.logger.error('AI server health check failed:', error.message);
      return false;
    }
  }

  /**
   * Get AI server health information
   */
  async getHealthInfo(): Promise<AIServerHealth | null> {
    try {
      const response: AxiosResponse<AIServerHealth> = await this.axiosInstance.get('/health');
      return response.data;
    } catch (error) {
      this.logger.error('Failed to get AI server health info:', error.message);
      return null;
    }
  }

  /**
   * Create image embeddings using the AI server
   */
  async createImageEmbedding(imageData: string, instruction?: string): Promise<number[]> {
    try {
      const response: AxiosResponse<AIServerEmbeddingResponse> = await this.axiosInstance.post('/embed/image', {
        image_data: imageData,
        instruction,
      });

      return response.data.embeddings[0];
    } catch (error) {
      this.logger.error('Failed to create image embedding:', error.message);
      throw new Error(`AI server image embedding failed: ${error.message}`);
    }
  }

  /**
   * Create text embeddings using the AI server
   */
  async createTextEmbedding(texts: string[], instruction?: string, normalize: boolean = true): Promise<number[][]> {
    try {
      const response: AxiosResponse<AIServerEmbeddingResponse> = await this.axiosInstance.post('/embed/text', {
        texts,
        instruction,
        normalize,
      });

      return response.data.embeddings;
    } catch (error) {
      this.logger.error('Failed to create text embedding:', error.message);
      throw new Error(`AI server text embedding failed: ${error.message}`);
    }
  }

  /**
   * Rerank candidates using the AI server
   */
  async rerankCandidates(query: string, candidates: any[], topK: number = 5): Promise<AIServerRerankResponse> {
    try {
      const response: AxiosResponse<AIServerRerankResponse> = await this.axiosInstance.post('/rerank', {
        query,
        candidates,
        top_k: topK,
      });

      return response.data;
    } catch (error) {
      this.logger.error('Failed to rerank candidates:', error.message);
      throw new Error(`AI server reranking failed: ${error.message}`);
    }
  }

  /**
   * Start a training task on the AI server
   */
  async startTraining(taskType: string, data: any, parameters?: any): Promise<AIServerTrainingResponse> {
    try {
      const response: AxiosResponse<AIServerTrainingResponse> = await this.axiosInstance.post('/train', {
        task_type: taskType,
        data,
        parameters,
      });

      return response.data;
    } catch (error) {
      this.logger.error('Failed to start training:', error.message);
      throw new Error(`AI server training failed: ${error.message}`);
    }
  }

  /**
   * Get GPU statistics from the AI server
   */
  async getGPUStats(): Promise<any> {
    try {
      const response = await this.axiosInstance.get('/gpu/stats');
      return response.data;
    } catch (error) {
      this.logger.error('Failed to get GPU stats:', error.message);
      return null;
    }
  }

  /**
   * Get system information from the AI server
   */
  async getSystemInfo(): Promise<any> {
    try {
      const response = await this.axiosInstance.get('/system/info');
      return response.data;
    } catch (error) {
      this.logger.error('Failed to get system info:', error.message);
      return null;
    }
  }

  /**
   * Fallback to local embedding service if AI server is unavailable
   */
  async createImageEmbeddingWithFallback(imageData: string, instruction?: string): Promise<number[]> {
    try {
      return await this.createImageEmbedding(imageData, instruction);
    } catch (error) {
      this.logger.warn('AI server unavailable, falling back to local embedding service');
      // Fallback to local service
      return await this.embeddingService.generateImageEmbedding({
        imageBase64: imageData,
        instruction,
      });
    }
  }

  /**
   * Fallback to local embedding service if AI server is unavailable
   */
  async createTextEmbeddingWithFallback(texts: string[], instruction?: string): Promise<number[][]> {
    try {
      return await this.createTextEmbedding(texts, instruction);
    } catch (error) {
      this.logger.warn('AI server unavailable, falling back to local embedding service');
      // Fallback to local service
      const embeddings = [];
      for (const text of texts) {
        const embedding = await this.embeddingService.generateTextEmbedding({
          title: text,
          instruction,
        });
        embeddings.push(embedding);
      }
      return embeddings;
    }
  }

  /**
   * Fallback to local reranker service if AI server is unavailable
   */
  async rerankCandidatesWithFallback(query: string, candidates: any[], topK: number = 5): Promise<any> {
    try {
      return await this.rerankCandidates(query, candidates, topK);
    } catch (error) {
      this.logger.warn('AI server unavailable, falling back to local reranker service');
      // Fallback to local service
      return await this.rerankerService.rerankCandidates({
        query,
        candidates,
        maxCandidates: topK,
      });
    }
  }

  /**
   * Check if AI server is preferred over local services
   */
  async shouldUseAIServer(): Promise<boolean> {
    const useAIServer = this.configService.get<string>('USE_AI_SERVER') === 'true';
    if (!useAIServer) {
      return false;
    }

    return await this.checkHealth();
  }

  /**
   * Get AI server configuration
   */
  getConfig(): AIServerConfig {
    return this.config;
  }

  /**
   * Test AI server connectivity
   */
  async testConnection(): Promise<{ success: boolean; error?: string; health?: AIServerHealth }> {
    try {
      const health = await this.getHealthInfo();
      if (health) {
        return { success: true, health };
      } else {
        return { success: false, error: 'Health check failed' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}


