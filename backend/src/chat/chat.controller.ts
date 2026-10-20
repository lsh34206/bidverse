import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsMongoId, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard, type AuthUser } from '../auth/jwt-auth.guard.js';
import { UserThrottlerGuard } from '../common/user-throttler.guard.js';
import { ChatService } from './chat.service.js';

class SendChatDto {
  /** 길이/내용 검증은 서비스에서 한다 (공백 정리 뒤에 세야 해서). 여기서는 터무니없이 큰 본문만 막는다. */
  @IsString()
  @MaxLength(2000)
  text: string;
}

class ListChatQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsMongoId()
  before?: string;
}

@Controller('auctions/:auctionId/chat')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  /** 채팅 내역은 로그인 없이도 볼 수 있다 (입찰 내역처럼 공개). */
  @Get()
  list(@Param('auctionId') auctionId: string, @Query() query: ListChatQuery) {
    return this.chat.list(auctionId, query.limit, query.before);
  }

  // 도배 방지: 사용자당 10초에 6건
  @Post()
  @UseGuards(JwtAuthGuard, UserThrottlerGuard)
  @Throttle({ default: { limit: 6, ttl: 10_000 } })
  send(@CurrentUser() user: AuthUser, @Param('auctionId') auctionId: string, @Body() dto: SendChatDto) {
    return this.chat.send(user, auctionId, dto.text);
  }

  @Delete(':messageId')
  @HttpCode(204)
  @UseGuards(JwtAuthGuard)
  remove(
    @CurrentUser() user: AuthUser,
    @Param('auctionId') auctionId: string,
    @Param('messageId') messageId: string,
  ) {
    return this.chat.remove(user, auctionId, messageId);
  }
}
