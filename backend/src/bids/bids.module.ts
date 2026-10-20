import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Auction, AuctionSchema } from '../auctions/auction.schema.js';
import { AuthModule } from '../auth/auth.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { SettlementModule } from '../settlement/settlement.module.js';
import { UsersModule } from '../users/users.module.js';
import { Bid, BidSchema } from './bid.schema.js';
import { BidsController } from './bids.controller.js';
import { BidsService } from './bids.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Bid.name, schema: BidSchema },
      { name: Auction.name, schema: AuctionSchema },
    ]),
    AuthModule,
    UsersModule,
    RealtimeModule,
    SettlementModule,
    NotificationsModule,
  ],
  controllers: [BidsController],
  providers: [BidsService],
})
export class BidsModule {}
