import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Auction, AuctionSchema } from '../auctions/auction.schema.js';
import { AuctionsModule } from '../auctions/auctions.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { Bid, BidSchema } from '../bids/bid.schema.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { Order, OrderSchema } from '../orders/order.schema.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { AuditLog, AuditLogSchema } from './audit-log.schema.js';
import { Report, ReportSchema } from './report.schema.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Auction.name, schema: AuctionSchema },
      { name: Bid.name, schema: BidSchema },
      { name: Order.name, schema: OrderSchema },
      { name: Report.name, schema: ReportSchema },
      { name: AuditLog.name, schema: AuditLogSchema },
    ]),
    AuthModule,
    AuctionsModule,
    NotificationsModule,
  ],
  controllers: [AdminController, ReportsController],
  providers: [AdminService, ReportsService],
})
export class AdminModule {}
