import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard, type AuthUser } from '../auth/jwt-auth.guard.js';
import { ListAuctionsQuery } from '../auctions/dto/list-auctions.query.js';
import { OrdersQuery, ReportsQuery, ResolveReportDto, SuspendDto, UpdateUserDto, UsersQuery } from './admin.dto.js';
import { AdminService } from './admin.service.js';

@Controller('admin')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('stats')
  stats() {
    return this.admin.stats();
  }

  @Get('auctions')
  auctions(@Query() query: ListAuctionsQuery) {
    return this.admin.listAuctions(query);
  }

  @Post('auctions/:id/suspend')
  @HttpCode(200)
  suspend(@CurrentUser() admin: AuthUser, @Param('id') id: string, @Body() dto: SuspendDto) {
    return this.admin.suspendAuction(admin.id, id, dto.reason);
  }

  @Post('auctions/:id/restore')
  @HttpCode(200)
  restore(@CurrentUser() admin: AuthUser, @Param('id') id: string) {
    return this.admin.restoreAuction(admin.id, id);
  }

  @Get('orders')
  orders(@Query() query: OrdersQuery) {
    return this.admin.listOrders(query.status, query.page, query.limit);
  }

  @Get('users')
  users(@Query() query: UsersQuery) {
    return this.admin.listUsers(query.q, query.page, query.limit);
  }

  @Patch('users/:id')
  updateUser(@CurrentUser() admin: AuthUser, @Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.admin.updateUser(admin.id, id, dto);
  }

  @Get('reports')
  reports(@Query() query: ReportsQuery) {
    return this.admin.listReports(query.status, query.page, query.limit);
  }

  @Post('reports/:id/resolve')
  @HttpCode(200)
  resolve(@CurrentUser() admin: AuthUser, @Param('id') id: string, @Body() dto: ResolveReportDto) {
    return this.admin.resolveReport(admin.id, id, dto);
  }

  @Get('audit')
  audit() {
    return this.admin.auditLog();
  }
}
