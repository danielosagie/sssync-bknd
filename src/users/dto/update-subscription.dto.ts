import { IsUUID, IsNotEmpty } from 'class-validator';

export class UpdateSubscriptionDto {
  @IsUUID()
  @IsNotEmpty()
  subscriptionTierId: string;
}
