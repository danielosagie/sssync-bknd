export interface PushOperationJobData {
  userId: string;
  entityId: string; // productId for product changes, variantId for inventory changes
  changeType: 'PRODUCT_CREATED' | 'PRODUCT_UPDATED' | 'PRODUCT_DELETED' | 'INVENTORY_UPDATED';
  // Optional: Add any other relevant data that the processor might need directly
} 