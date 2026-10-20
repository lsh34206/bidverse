import { Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard, type AuthUser } from '../auth/jwt-auth.guard.js';
import { OrdersService } from './orders.service.js';

@Controller()
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get('me/orders')
  listMine(@CurrentUser() user: AuthUser) {
    return this.orders.listMine(user);
  }

  @Get('orders/:id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.orders.findOne(user, id);
  }

  @Post('orders/:id/ship')
  @HttpCode(200)
  ship(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.orders.advance(user, id, 'ship');
  }

  @Post('orders/:id/confirm')
  @HttpCode(200)
  confirm(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.orders.advance(user, id, 'confirm');
  }
}
