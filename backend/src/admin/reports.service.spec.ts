import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { Auction } from '../auctions/auction.schema.js';
import { Report } from './report.schema.js';
import { ReportsService } from './reports.service.js';

const oid = () => new Types.ObjectId();
const lean = <T>(value: T) => ({ lean: () => ({ exec: () => Promise.resolve(value) }) });

describe('ReportsService', () => {
  let service: ReportsService;
  const reports = { create: vi.fn() };
  const auctions = { findById: vi.fn() };
  const userId = oid().toString();
  const auctionId = oid().toString();

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: getModelToken(Report.name), useValue: reports },
        { provide: getModelToken(Auction.name), useValue: auctions },
      ],
    }).compile();
    service = module.get(ReportsService);
  });

  it('신고를 접수한다', async () => {
    auctions.findById.mockReturnValue(lean({ sellerId: oid() }));
    reports.create.mockResolvedValue({});
    expect(await service.create(userId, auctionId, '가짜 상품 같아요')).toEqual({ reported: true });
    expect(reports.create).toHaveBeenCalledWith({ auctionId, reporterId: userId, reason: '가짜 상품 같아요' });
  });

  it('본인 경매, 없는 경매, 잘못된 id는 거절한다', async () => {
    auctions.findById.mockReturnValue(lean({ sellerId: new Types.ObjectId(userId) }));
    await expect(service.create(userId, auctionId, '사유입니다')).rejects.toBeInstanceOf(BadRequestException);
    auctions.findById.mockReturnValue(lean(null));
    await expect(service.create(userId, auctionId, '사유입니다')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.create(userId, 'nope', '사유입니다')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('같은 경매를 또 신고하면 409', async () => {
    auctions.findById.mockReturnValue(lean({ sellerId: oid() }));
    reports.create.mockRejectedValue({ code: 11000 });
    await expect(service.create(userId, auctionId, '사유입니다')).rejects.toBeInstanceOf(ConflictException);
  });
});
