import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard, type AuthUser } from '../auth/jwt-auth.guard.js';
import { AuctionsService } from './auctions.service.js';
import { CreateAuctionDto } from './dto/create-auction.dto.js';
import { ListAuctionsQuery } from './dto/list-auctions.query.js';
import { UpdateAuctionDto } from './dto/update-auction.dto.js';

@Controller('auctions')
export class AuctionsController {
  constructor(private readonly auctions: AuctionsService) {}

  @Get()
  list(@Query() query: ListAuctionsQuery) {
    return this.auctions.list(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.auctions.findOne(id);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateAuctionDto) {
    return this.auctions.create(user, dto);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateAuctionDto) {
    return this.auctions.update(user, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(JwtAuthGuard)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.auctions.remove(user, id);
  }
}
