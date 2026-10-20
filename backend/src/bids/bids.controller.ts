import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard, type AuthUser } from '../auth/jwt-auth.guard.js';
import { Throttle } from '@nestjs/throttler';
import { UserThrottlerGuard } from '../common/user-throttler.guard.js';
import { BidsService } from './bids.service.js';
import { PlaceBidDto } from './dto/place-bid.dto.js';

@Controller('auctions/:auctionId')
export class BidsController {
  constructor(private readonly bids: BidsService) {}

  @Post('bids')
  // 사용자당 10초에 15회. 자동 입찰 봇이나 연타로 서버를 흔드는 것을 막는다.
  @UseGuards(JwtAuthGuard, UserThrottlerGuard)
  @Throttle({ default: { limit: 15, ttl: 10_000 } })
  place(
    @CurrentUser() user: AuthUser,
    @Param('auctionId') auctionId: string,
    @Body() dto: PlaceBidDto,
  ) {
    return this.bids.place(user, auctionId, dto.amount);
  }

  @Get('bids')
  list(@Param('auctionId') auctionId: string, @Query('limit') limit?: string) {
    return this.bids.list(auctionId, limit ? Number(limit) || undefined : undefined);
  }

  @Post('buy-now')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, UserThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 10_000 } })
  buyNow(@CurrentUser() user: AuthUser, @Param('auctionId') auctionId: string) {
    return this.bids.buyNow(user, auctionId);
  }
}
