import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { Auction } from '../auctions/auction.schema.js';
import { AuctionsService } from '../auctions/auctions.service.js';
import { Watch } from './watch.schema.js';

const MAX_WATCH = 200;

@Injectable()
export class WatchlistService {
  constructor(
    @InjectModel(Watch.name) private readonly watches: Model<Watch>,
    @InjectModel(Auction.name) private readonly auctions: Model<Auction>,
    private readonly auctionsService: AuctionsService,
  ) {}

  /** 이미 담겨 있어도 성공으로 본다(멱등). */
  async add(userId: string, auctionId: string): Promise<{ watching: true }> {
    this.assertId(auctionId);
    const exists = await this.auctions.exists({ _id: auctionId, suspended: { $ne: true } }).exec();
    if (!exists) throw new NotFoundException('경매를 찾을 수 없습니다');

    await this.watches
      .updateOne({ userId, auctionId }, { $setOnInsert: { userId, auctionId } }, { upsert: true })
      .exec();
    return { watching: true };
  }

  async remove(userId: string, auctionId: string): Promise<{ watching: false }> {
    this.assertId(auctionId);
    await this.watches.deleteOne({ userId, auctionId }).exec();
    return { watching: false };
  }

  async ids(userId: string): Promise<string[]> {
    const docs = await this.watches
      .find({ userId }, { auctionId: 1 })
      .sort({ createdAt: -1 })
      .limit(MAX_WATCH)
      .lean()
      .exec();
    return docs.map((d) => String(d.auctionId));
  }

  async list(userId: string) {
    return this.auctionsService.viewsByIds(await this.ids(userId));
  }

  /** 종료 임박 알림 대상 */
  async watcherIds(auctionId: string): Promise<string[]> {
    const docs = await this.watches.find({ auctionId }, { userId: 1 }).lean().exec();
    return docs.map((d) => String(d.userId));
  }

  private assertId(id: string): void {
    if (!isValidObjectId(id)) throw new BadRequestException('잘못된 경매 ID');
  }
}
