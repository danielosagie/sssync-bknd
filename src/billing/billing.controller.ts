import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { BillingService } from './billing.service';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';

@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Post('portal')
  @UseGuards(SupabaseAuthGuard)
  async createPortal(@Req() req: any) {
    const user: { id: string; email?: string } = req.user;
    const url = await this.billing.createCustomerPortal(user.id, user.email);
    return { url };
  }
}





