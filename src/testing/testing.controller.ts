import { Controller, Get, Logger, Query, Post, Body, Param } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ShopifyAdapter } from '../platform-adapters/shopify/shopify.adapter';
import { PlatformConnectionsService, PlatformConnection } from '../platform-connections/platform-connections.service'; // Adjust path
import { ShopifyApiClient } from '../platform-adapters/shopify/shopify-api-client.service'; // Adjust path
import { InitialScanProcessor } from '../sync-engine/processors/initial-scan.processor';

@Controller('test')
export class TestingController {
    private readonly logger = new Logger(TestingController.name);
    private readonly defaultTestUserId: string | undefined;

    constructor(
        private readonly shopifyAdapter: ShopifyAdapter,
        private readonly connectionsService: PlatformConnectionsService,
        private readonly configService: ConfigService,
        private readonly initialScanProcessor: InitialScanProcessor,
    ) {
        this.defaultTestUserId = this.configService.get<string>('DEFAULT_TEST_USER_ID');
    }

    @Get('shopify/fetch-all')
    async testFetchAllData(
        @Query('connectionId') connectionId: string,
        @Query('userId') userIdFromQuery?: string,
    ) {
        if (!connectionId) {
            return { error: 'connectionId query parameter is required.' };
        }

        let effectiveUserId = userIdFromQuery || this.defaultTestUserId;

        if (!effectiveUserId || effectiveUserId === '<YOUR_TEST_USER_ID>') {
            effectiveUserId = '<YOUR_TEST_USER_ID>';
            this.logger.error(
                'Test User ID is not configured. Please pass userId as a query parameter ' +
                'or set DEFAULT_TEST_USER_ID in your environment variables. ' +
                'Falling back to placeholder an unsafe placeholder value.',
            );
            if (effectiveUserId === '<YOUR_TEST_USER_ID>') {
                 return { 
                    error: 'CRITICAL: Test User ID is using an unsafe placeholder. ' + 
                           'Configure it via userId query parameter or DEFAULT_TEST_USER_ID env variable.' 
                };
            }
        }
        
        this.logger.log(`Using connectionId: ${connectionId}, effectiveUserId: ${effectiveUserId}`);

        try {
            const connection = await this.connectionsService.getConnectionById(connectionId, effectiveUserId);
            if (!connection) {
                return { error: `Connection with ID ${connectionId} (and user ID ${effectiveUserId}) not found.`};
            }
            if (connection.PlatformType !== 'Shopify') {
                 return { error: `Connection ${connectionId} is not a Shopify connection.`};
            }

            const apiClient: ShopifyApiClient = this.shopifyAdapter.getApiClient(connection);
            this.logger.log(`Attempting to fetch all relevant data for connection: ${connection.Id}, shop: ${connection.PlatformSpecificData?.['shop']}`);
            const result = await apiClient.fetchAllRelevantData(connection);

            this.logger.log(`Successfully fetched data. Products: ${result.products.length}, Locations: ${result.locations.length}`);
            if (result.products.length > 0) {
                this.logger.debug('First product: ' + JSON.stringify(result.products[0], null, 2).substring(0, 1000) + '...');
            }
            if (result.locations.length > 0) {
                this.logger.debug('First location: ' + JSON.stringify(result.locations[0], null, 2));
            }

            return {
                message: 'Test executed. Check server logs for full details.',
                productsCount: result.products.length,
                locationsCount: result.locations.length,
                firstProductId: result.products.length > 0 ? result.products[0].id : null,
                firstLocationId: result.locations.length > 0 ? result.locations[0].id : null,
            };
        } catch (error) {
            this.logger.error(`Test fetch all data failed for connection ${connectionId}: ${error.message}`, error.stack);
            return { error: `Test failed: ${error.message}` };
        }
    }

    @Post('connections/:connectionId/process-scan')
    async testProcessScan(
        @Param('connectionId') connectionId: string,
        @Query('userId') userIdFromQuery?: string,
    ) {
        if (!connectionId) {
            return { error: 'connectionId path parameter is required.' };
        }

        let effectiveUserId = userIdFromQuery || this.defaultTestUserId;
        if (!effectiveUserId || effectiveUserId === '<YOUR_TEST_USER_ID>') {
            this.logger.error(
                'Test User ID is not configured for process-scan. Please pass userId as a query parameter ' +
                'or set DEFAULT_TEST_USER_ID in your environment variables. Cannot proceed safely.',
            );
            return { 
                error: 'CRITICAL: Test User ID is not configured or using an unsafe placeholder. ' + 
                       'Configure it via userId query parameter or DEFAULT_TEST_USER_ID env variable.' 
            };
        }

        this.logger.log(`Test Process Scan: Using connectionId: ${connectionId}, effectiveUserId: ${effectiveUserId}`);

        try {
            const connection = await this.connectionsService.getConnectionById(connectionId, effectiveUserId);
            if (!connection) {
                return { error: `Connection with ID ${connectionId} (and user ID ${effectiveUserId}) not found.`};
            }

            if (connection.Status !== 'scanning') {
                this.logger.warn(`Connection ${connectionId} status is ${connection.Status}. Temporarily setting to 'scanning' for test processing.`);
            }

            const result = await this.initialScanProcessor.triggerScanProcessingForConnection(
                connection.Id,
                effectiveUserId,
                connection.PlatformType
            );

            this.logger.log(`Successfully triggered and completed scan processing for connection: ${connection.Id}. Result: ${JSON.stringify(result)}`);
            return {
                message: 'Test scan processing executed. Check server logs for full details.',
                result: result,
            };
        } catch (error) {
            this.logger.error(`Test process scan failed for connection ${connectionId}: ${error.message}`, error.stack);
            return { error: `Test process scan failed: ${error.message}` };
        }
    }
}
