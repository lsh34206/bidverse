import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { SNIPING_WINDOW_MS } from '../auctions/auction.constants.js';
import { Auction } from '../auctions/auction.schema.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { SettlementService } from '../settlement/settlement.service.js';
import { Bid } from './bid.schema.js';
import { BidsGateway } from './bids.gateway.js';
import { BidsService } from './bids.service.js';

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const oid = () => new Types.ObjectId();
const exec = <T>(value: T) => ({ exec: () => Promise.resolve(value) });

describe('BidsService', () => {
  let service: BidsService;
  const auctions = { findOneAndUpdate: vi.fn(), findById: vi.fn() };
  const bids = { create: vi.fn() };
  const gateway = { emitBid: vi.fn(), notifyUser: vi.fn() };
  const settlement = { settle: vi.fn() };
  const notifications = { notify: vi.fn() };

  const bidder = { id: oid().toString(), role: 'buyer', nickname: 'hong' };
  const auctionId = oid().toString();

  const auctionDoc = (over: Record<string, unknown> = {}) => ({
    sellerId: oid(),
    title: '시계',
    startPrice: 1000,
    currentPrice: 1000,
    minIncrement: 500,
    bidCount: 0,
    extensionCount: 0,
    buyNowPrice: null,
    startsAt: new Date(Date.now() - HOUR),
    endsAt: new Date(Date.now() + HOUR),
    highestBidderId: undefined,
    ...over,
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    settlement.settle.mockResolvedValue(true);
    bids.create.mockImplementation(async (d) => ({ ...d, id: 'bid1', createdAt: new Date() }));
    const module = await Test.createTestingModule({
      providers: [
        BidsService,
        { provide: getModelToken(Auction.name), useValue: auctions },
        { provide: getModelToken(Bid.name), useValue: bids },
        { provide: BidsGateway, useValue: gateway },
        { provide: SettlementService, useValue: settlement },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = module.get(BidsService);
  });

  describe('place', () => {
    it('원자적 조건부 업데이트로 입찰하고 마스킹된 닉네임으로 브로드캐스트한다', async () => {
      auctions.findOneAndUpdate.mockReturnValue(exec(auctionDoc({ bidCount: 2, currentPrice: 2000 })));

      const res = await service.place(bidder, auctionId, 2500);

      const [filter, update, options] = auctions.findOneAndUpdate.mock.calls[0];
      expect(filter._id).toBe(auctionId);
      expect(filter.sellerId).toEqual({ $ne: bidder.id });
      expect(filter.highestBidderId).toEqual({ $ne: bidder.id });
      expect(Array.isArray(update)).toBe(true); // 집계 파이프라인 업데이트
      expect(update[0].$set.currentPrice).toBe(2500);
      expect(update[0].$set.highestBidderId.toString()).toBe(bidder.id);
      expect(options).toMatchObject({ returnDocument: 'before', updatePipeline: true }); // Mongoose 9는 파이프라인 업데이트에 이 옵션이 꼭 필요하다

      expect(res).toMatchObject({ currentPrice: 2500, bidCount: 3, minNextBid: 3000, extended: false });
      expect(res.bid.bidder).toBe('h***');
      expect(gateway.emitBid).toHaveBeenCalledWith(expect.objectContaining({ auctionId, bidCount: 3 }));
    });

    it('종료 5분 이내 입찰이면 종료 시각을 늦추고 extended로 알린다', async () => {
      auctions.findOneAndUpdate.mockReturnValue(
        exec(auctionDoc({ endsAt: new Date(Date.now() + MIN) })),
      );
      const before = Date.now();

      const res = await service.place(bidder, auctionId, 1000);

      expect(res.extended).toBe(true);
      expect(res.endsAt.getTime()).toBeGreaterThanOrEqual(before + SNIPING_WINDOW_MS);
      expect(gateway.emitBid).toHaveBeenCalledWith(expect.objectContaining({ extended: true }));
    });

    it('마감이 넉넉하면 종료 시각이 그대로다', async () => {
      const doc = auctionDoc();
      auctions.findOneAndUpdate.mockReturnValue(exec(doc));
      const res = await service.place(bidder, auctionId, 1000);
      expect(res.extended).toBe(false);
      expect(res.endsAt).toEqual(doc.endsAt);
    });

    it('이전 최고가 입찰자에게만 outbid 알림을 보낸다', async () => {
      const previous = oid();
      auctions.findOneAndUpdate.mockReturnValue(
        exec(auctionDoc({ bidCount: 1, currentPrice: 1000, highestBidderId: previous })),
      );

      await service.place(bidder, auctionId, 1500);

      expect(notifications.notify).toHaveBeenCalledWith(
        previous.toString(),
        expect.objectContaining({ type: 'outbid', auctionId, amount: 1500, title: '시계' }),
      );
    });

    it('첫 입찰에는 outbid 알림이 없다', async () => {
      auctions.findOneAndUpdate.mockReturnValue(exec(auctionDoc()));
      await service.place(bidder, auctionId, 1000);
      expect(notifications.notify).not.toHaveBeenCalled();
    });

    describe('거절 사유', () => {
      const reject = async (doc: unknown) => {
        auctions.findOneAndUpdate.mockReturnValue(exec(null));
        auctions.findById.mockReturnValue(exec(doc));
        return service.place(bidder, auctionId, 1200).catch((e) => e);
      };

      it('경매가 없으면 404', async () => {
        expect(await reject(null)).toBeInstanceOf(NotFoundException);
      });

      it('판매자 본인이면 403', async () => {
        const err = await reject(auctionDoc({ sellerId: new Types.ObjectId(bidder.id) }));
        expect(err).toBeInstanceOf(ForbiddenException);
      });

      it('종료된 경매면 409', async () => {
        const err = await reject(auctionDoc({ endsAt: new Date(Date.now() - 1000) }));
        expect(err).toBeInstanceOf(ConflictException);
        expect(err.message).toContain('종료');
      });

      it('시작 전이면 409', async () => {
        const err = await reject(auctionDoc({ startsAt: new Date(Date.now() + HOUR) }));
        expect(err.message).toContain('시작되지 않은');
      });

      it('이미 최고가 입찰자면 409', async () => {
        const err = await reject(auctionDoc({ highestBidderId: new Types.ObjectId(bidder.id) }));
        expect(err.message).toContain('최고가 입찰자');
      });

      it('금액이 낮으면 최소 입찰가를 알려 준다', async () => {
        const err = await reject(auctionDoc({ bidCount: 1, currentPrice: 1000, minIncrement: 500 }));
        expect(err).toBeInstanceOf(ConflictException);
        expect(err.message).toContain('1,500');
      });

      it('관리자에 의해 중지된 경매는 그렇다고 알려 준다', async () => {
        const err = await reject(auctionDoc({ suspended: true }));
        expect(err).toBeInstanceOf(ConflictException);
        expect(err.message).toContain('중지');
      });

      it('거절되면 기록도 브로드캐스트도 하지 않는다', async () => {
        await reject(auctionDoc());
        expect(bids.create).not.toHaveBeenCalled();
        expect(gateway.emitBid).not.toHaveBeenCalled();
      });
    });

    it('입찰 기록 저장이 실패해도 입찰은 성공으로 처리한다', async () => {
      auctions.findOneAndUpdate.mockReturnValue(exec(auctionDoc()));
      bids.create.mockRejectedValue(new Error('db down'));
      const res = await service.place(bidder, auctionId, 1000);
      expect(res.currentPrice).toBe(1000);
      expect(bids.create).toHaveBeenCalledTimes(2);
      expect(gateway.emitBid).toHaveBeenCalled();
    });
  });

  describe('buyNow', () => {
    it('즉시구매가로 낙찰시키고 곧바로 정산한다', async () => {
      const previous = oid();
      auctions.findOneAndUpdate.mockReturnValue(
        exec(auctionDoc({ buyNowPrice: 10000, bidCount: 2, currentPrice: 3000, highestBidderId: previous })),
      );

      const res = await service.buyNow(bidder, auctionId);

      expect(res).toMatchObject({ currentPrice: 10000, bidCount: 3, highestBidderId: bidder.id });
      expect(bids.create).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 10000, bidderNickname: 'hong' }),
      );
      expect(gateway.emitBid).toHaveBeenCalled();
      expect(notifications.notify).toHaveBeenCalledWith(
        previous.toString(),
        expect.objectContaining({ type: 'outbid', amount: 10000 }),
      );
      expect(settlement.settle).toHaveBeenCalledWith(auctionId);
    });

    it('즉시 정산이 실패해도 구매는 성공으로 돌려준다', async () => {
      auctions.findOneAndUpdate.mockReturnValue(exec(auctionDoc({ buyNowPrice: 10000 })));
      settlement.settle.mockRejectedValue(new Error('boom'));
      await expect(service.buyNow(bidder, auctionId)).resolves.toMatchObject({ currentPrice: 10000 });
    });

    describe('거절 사유', () => {
      const reject = async (doc: unknown) => {
        auctions.findOneAndUpdate.mockReturnValue(exec(null));
        auctions.findById.mockReturnValue(exec(doc));
        return service.buyNow(bidder, auctionId).catch((e) => e);
      };

      it('즉시구매가가 없으면 409', async () => {
        const err = await reject(auctionDoc({ buyNowPrice: null }));
        expect(err).toBeInstanceOf(ConflictException);
        expect(err.message).toContain('즉시구매가 없는');
      });

      it('현재가가 즉시구매가에 닿았으면 409', async () => {
        const err = await reject(auctionDoc({ buyNowPrice: 5000, currentPrice: 5000 }));
        expect(err.message).toContain('도달');
      });

      it('판매자 본인이면 403', async () => {
        const err = await reject(auctionDoc({ sellerId: new Types.ObjectId(bidder.id), buyNowPrice: 5000 }));
        expect(err).toBeInstanceOf(ForbiddenException);
      });

      it('거절되면 정산하지 않는다', async () => {
        await reject(auctionDoc());
        expect(settlement.settle).not.toHaveBeenCalled();
        expect(bids.create).not.toHaveBeenCalled();
      });
    });
  });
});
