import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Auction, AuctionSchema } from '../auctions/auction.schema.js';
import { AuctionsModule } from '../auctions/auctions.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { EndingSoonService } from './ending-soon.service.js';
import { Watch, WatchSchema } from './watch.schema.js';
import { WatchlistController } from './watchlist.controller.js';
import { WatchlistService } from './watchlist.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Watch.name, schema: WatchSchema },
      { name: Auction.name, schema: AuctionSchema },
    ]),
    AuctionsModule,
    AuthModule,
    NotificationsModule,
  ],
  controllers: [WatchlistController],
  providers: [WatchlistService, EndingSoonService],
  exports: [WatchlistService],
})
export class WatchlistModule {}
