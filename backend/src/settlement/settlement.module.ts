import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Auction, AuctionSchema } from '../auctions/auction.schema.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { UsersModule } from '../users/users.module.js';
import { SettlementService } from './settlement.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Auction.name, schema: AuctionSchema }]),
    OrdersModule,
    NotificationsModule,
    RealtimeModule,
    UsersModule,
  ],
  providers: [SettlementService],
  exports: [SettlementService],
})
export class SettlementModule {}
