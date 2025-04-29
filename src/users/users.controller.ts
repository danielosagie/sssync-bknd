import { Controller, Param, Body, Patch, ParseUUIDPipe, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { UsersService } from './users.service';
import { UpdateSubscriptionDto } from './dto/update-subscription.dto';
// Import an appropriate Guard (e.g., AdminGuard, or SupabaseAuthGuard if users can change their own tier?)
// import { AdminGuard } from '../auth/guards/admin.guard'; // Example

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // ... other user endpoints ...

  // Example: Protect with a hypothetical AdminGuard
  // @UseGuards(AdminGuard) // Apply appropriate guard!
  @Patch(':userId/subscription')
  @HttpCode(HttpStatus.NO_CONTENT) // Return 204 No Content on success
  async updateSubscription(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() updateSubscriptionDto: UpdateSubscriptionDto,
  ): Promise<void> {
    await this.usersService.updateUserSubscription(userId, updateSubscriptionDto.subscriptionTierId);
  }
}
