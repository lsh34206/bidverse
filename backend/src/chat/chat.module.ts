import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Auction, AuctionSchema } from '../auctions/auction.schema.js';
import { AuthModule } from '../auth/auth.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { ChatMessage, ChatMessageSchema } from './chat-message.schema.js';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ChatMessage.name, schema: ChatMessageSchema },
      { name: Auction.name, schema: AuctionSchema },
    ]),
    AuthModule,
    RealtimeModule,
  ],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
