import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserThrottlerGuard } from '../common/user-throttler.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard, type AuthUser } from '../auth/jwt-auth.guard.js';
import { CreateReportDto } from './admin.dto.js';
import { ReportsService } from './reports.service.js';

@Controller('auctions/:auctionId/report')
@UseGuards(JwtAuthGuard, UserThrottlerGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  // 신고 도배 방지: 사용자당 분당 5회
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post()
  @HttpCode(201)
  create(
    @CurrentUser() user: AuthUser,
    @Param('auctionId') auctionId: string,
    @Body() dto: CreateReportDto,
  ) {
    return this.reports.create(user.id, auctionId, dto.reason);
  }
}
