import { Injectable, NotFoundException, InternalServerErrorException, BadRequestException } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseService } from '../common/supabase.service'; // Adjust path

@Injectable()
export class UsersService {
  private supabase: SupabaseClient;

  constructor(private supabaseService: SupabaseService) {
    this.supabase = this.supabaseService.getClient();
  }

  // ... other methods like findOne, create ...

  async updateUserSubscription(userId: string, tierId: string): Promise<void> {
    // 1. Verify the tierId exists
    const { data: tierExists, error: tierError } = await this.supabase
      .from('SubscriptionTiers')
      .select('Id')
      .eq('Id', tierId)
      .maybeSingle();

    if (tierError) {
      throw new InternalServerErrorException('Error verifying subscription tier.');
    }
    if (!tierExists) {
      throw new BadRequestException(`Subscription tier with ID ${tierId} not found.`);
    }

    // 2. Update the user's record
    const { error: updateError } = await this.supabase
      .from('Users')
      .update({ SubscriptionTierId: tierId, UpdatedAt: new Date().toISOString() })
      .eq('Id', userId);

    if (updateError) {
       // Check for foreign key violation or other errors
       if (updateError.code === '23503') { // Foreign key violation likely means userId doesn't exist
           throw new NotFoundException(`User with ID ${userId} not found.`);
       }
      throw new InternalServerErrorException('Failed to update user subscription.');
    }
  }
}
