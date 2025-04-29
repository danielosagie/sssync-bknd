// src/common/decorators/limit-type.decorator.ts
import { SetMetadata } from '@nestjs/common';

// Define the types of limits your guard can check
export enum LimitType {
  AI_SCAN = 'aiScan',
  SYNC_OPERATION = 'syncOperation',
  PRODUCT = 'product',
  // Add other limits as needed
}

export const LIMIT_TYPE_KEY = 'limitType';

// Decorator to apply to controller methods/classes
export const CheckSubscriptionLimit = (limitType: LimitType) =>
  SetMetadata(LIMIT_TYPE_KEY, limitType);
