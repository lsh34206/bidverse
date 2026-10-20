import { Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard, type AuthUser } from '../auth/jwt-auth.guard.js';
import { WatchlistService } from './watchlist.service.js';

@Controller()
@UseGuards(JwtAuthGuard)
export class WatchlistController {
  constructor(private readonly watchlist: WatchlistService) {}

  @Post('watchlist/:auctionId')
  @HttpCode(200)
  add(@CurrentUser() user: AuthUser, @Param('auctionId') auctionId: string) {
    return this.watchlist.add(user.id, auctionId);
  }

  @Delete('watchlist/:auctionId')
  remove(@CurrentUser() user: AuthUser, @Param('auctionId') auctionId: string) {
    return this.watchlist.remove(user.id, auctionId);
  }

  @Get('me/watchlist')
  list(@CurrentUser() user: AuthUser) {
    return this.watchlist.list(user.id);
  }

  /** 상세/목록 화면에서 하트 표시용으로 가볍게 쓰는 id 목록 */
  @Get('me/watchlist/ids')
  ids(@CurrentUser() user: AuthUser) {
    return this.watchlist.ids(user.id);
  }
}
