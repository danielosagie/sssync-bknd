import { Injectable } from '@nestjs/common';
import Stripe from 'stripe';
import { SupabaseService } from '../common/supabase.service';

@Injectable()
export class BillingService {
  private stripe: Stripe;
  constructor(private readonly supabaseService: SupabaseService) {
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
      apiVersion: '2025-07-30.basil',
    });
  }

  async createCustomerPortal(userId: string, email?: string) {
    // Fetch or create stripe customer id
    const supabase = this.supabaseService.getServiceClient();
    const { data: profile } = await supabase
      .from('Users')
      .select('StripeCustomerId')
      .eq('Id', userId)
      .maybeSingle();

    let customerId = profile?.StripeCustomerId as string | undefined;
    if (!customerId) {
      const customer = await this.stripe.customers.create({ email });
      customerId = customer.id;
      await supabase
        .from('Users')
        .update({ StripeCustomerId: customerId })
        .eq('Id', userId);
    }

    const session = await this.stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: process.env.BILLING_RETURN_URL || 'https://app.sssync.app',
    });
    return session.url;
  }
}


