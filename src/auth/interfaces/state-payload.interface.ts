export interface StatePayload {
    userId: string;
    platform: 'shopify' | 'clover' | 'square' | 'shopify-intermediate';
    nonce: string;
    finalRedirectUri: string; // The URL/URI to redirect the user back to the client app
    shop?: string; // For Shopify
}