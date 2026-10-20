import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { Auction } from '../auctions/auction.schema.js';
import { Report } from './report.schema.js';

/** 일반 사용자의 신고 접수. 처리는 관리자 쪽(AdminService.resolveReport)에서 한다. */
@Injectable()
export class ReportsService {
  constructor(
    @InjectModel(Report.name) private readonly reports: Model<Report>,
    @InjectModel(Auction.name) private readonly auctions: Model<Auction>,
  ) {}

  async create(userId: string, auctionId: string, reason: string): Promise<{ reported: true }> {
    if (!isValidObjectId(auctionId)) throw new BadRequestException('잘못된 경매 ID');
    const auction = await this.auctions.findById(auctionId, { sellerId: 1 }).lean().exec();
    if (!auction) throw new NotFoundException('경매를 찾을 수 없습니다');
    if (String(auction.sellerId) === userId) {
      throw new BadRequestException('본인의 경매는 신고할 수 없습니다');
    }

    try {
      await this.reports.create({ auctionId, reporterId: userId, reason });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        throw new ConflictException('이미 신고한 경매입니다');
      }
      throw err;
    }
    return { reported: true };
  }
}
