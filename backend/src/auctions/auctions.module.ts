import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module.js';
import { Auction, AuctionSchema } from './auction.schema.js';
import { AuctionsController } from './auctions.controller.js';
import { AuctionsService } from './auctions.service.js';

@Module({
  imports: [MongooseModule.forFeature([{ name: Auction.name, schema: AuctionSchema }]), AuthModule],
  controllers: [AuctionsController],
  providers: [AuctionsService],
  exports: [AuctionsService],
})
export class AuctionsModule {}
