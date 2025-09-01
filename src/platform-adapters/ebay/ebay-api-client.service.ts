import { Injectable, Logger, UnauthorizedException, InternalServerErrorException } from '@nestjs/common';
import { PlatformConnection, PlatformConnectionsService } from '../../platform-connections/platform-connections.service';
import axios, { AxiosInstance } from 'axios';

@Injectable()
export class EbayApiClient {
  private readonly logger = new Logger(EbayApiClient.name);
  private axiosInstance: AxiosInstance;

  constructor(private readonly connectionsService: PlatformConnectionsService) {
    this.axiosInstance = axios.create({ baseURL: 'https://api.sandbox.ebay.com' });
  }

  private async getAccessToken(connection: PlatformConnection): Promise<string> {
    const creds = await this.connectionsService.getDecryptedCredentials(connection);
    const token = creds?.accessToken || creds?.access_token;
    if (!token) throw new UnauthorizedException('Missing eBay access token');
    return token;
  }

  async fetchAllRelevantData(connection: PlatformConnection): Promise<{ items: any[]; locations: any[] }> {
    const accessToken = await this.getAccessToken(connection);
    try {
      // Inventory items (read-only first). Consider pagination in a loop.
      const resp = await this.axiosInstance.get('/sell/inventory/v1/inventory_item', {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { limit: 100 },
      });
      const items = resp.data?.inventoryItems || [];
      return { items, locations: [] };
    } catch (e: any) {
      this.logger.error(`eBay fetch failed: ${e?.response?.status} ${e?.message}`);
      throw new InternalServerErrorException('eBay fetchAllRelevantData failed');
    }
  }
}






