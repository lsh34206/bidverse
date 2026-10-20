import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { Auction } from '../auctions/auction.schema.js';
import { BidsGateway } from '../bids/bids.gateway.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { OrdersService } from '../orders/orders.service.js';
import { UsersService } from '../users/users.service.js';
import { SettlementService } from './settlement.service.js';

const oid = () => new Types.ObjectId();
const exec = <T>(value: T) => ({ exec: () => Promise.resolve(value) });

describe('SettlementService', () => {
  let service: SettlementService;
  const auctions = { find: vi.fn(), findOne: vi.fn(), findOneAndUpdate: vi.fn() };
  const orders = { createForAuction: vi.fn() };
  const users = { findById: vi.fn() };
  const gateway = { emitEnded: vi.fn() };
  const notifications = { notify: vi.fn() };

  const sellerId = oid();
  const winnerId = oid();
  const auctionDoc = (over: Record<string, unknown> = {}) => {
    const _id = oid();
    return {
      _id,
      id: _id.toString(),
      sellerId,
      title: '시계',
      currentPrice: 5000,
      highestBidderId: winnerId,
      ...over,
    };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.DISABLE_SCHEDULERS = 'true'; // 테스트에서 타이머가 돌지 않게 한다
    users.findById.mockResolvedValue({ nickname: 'kim' });
    orders.createForAuction.mockResolvedValue({ id: 'order1' });
    const module = await Test.createTestingModule({
      providers: [
        SettlementService,
        { provide: getModelToken(Auction.name), useValue: auctions },
        { provide: OrdersService, useValue: orders },
        { provide: UsersService, useValue: users },
        { provide: BidsGateway, useValue: gateway },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = module.get(SettlementService);
  });

  describe('settle', () => {
    it('낙찰: 주문을 만들고, 확정하고, 낙찰자·판매자에게 알린다', async () => {
      const doc = auctionDoc();
      auctions.findOne.mockReturnValue(exec(doc));
      auctions.findOneAndUpdate.mockReturnValue(exec({ ...doc, settledAt: new Date() }));

      expect(await service.settle(doc._id)).toBe(true);

      expect(orders.createForAuction).toHaveBeenCalledWith({
        auctionId: doc._id,
        title: '시계',
        buyerId: winnerId,
        sellerId,
        finalPrice: 5000,
      });
      const [filter, update] = auctions.findOneAndUpdate.mock.calls[0];
      expect(filter.settledAt).toBeNull(); // 정산 전인 문서만 확정 대상
      expect(filter.suspended).toEqual({ $ne: true }); // 중지된 경매는 확정하지 않는다
      expect(update.$set.result).toBe('sold');

      expect(gateway.emitEnded).toHaveBeenCalledWith(
        expect.objectContaining({ auctionId: doc.id, result: 'sold', winner: 'k***', finalPrice: 5000 }),
      );
      expect(notifications.notify).toHaveBeenCalledWith(
        winnerId.toString(),
        expect.objectContaining({ type: 'won', orderId: 'order1', amount: 5000 }),
      );
      expect(notifications.notify).toHaveBeenCalledWith(
        sellerId.toString(),
        expect.objectContaining({ type: 'sold' }),
      );
    });

    it('유찰: 주문 없이 확정하고 판매자에게만 알린다', async () => {
      const doc = auctionDoc({ highestBidderId: undefined });
      auctions.findOne.mockReturnValue(exec(doc));
      auctions.findOneAndUpdate.mockReturnValue(exec({ ...doc, settledAt: new Date() }));

      expect(await service.settle(doc._id)).toBe(true);

      expect(orders.createForAuction).not.toHaveBeenCalled();
      expect(auctions.findOneAndUpdate.mock.calls[0][1].$set.result).toBe('unsold');
      expect(gateway.emitEnded).toHaveBeenCalledWith(
        expect.objectContaining({ result: 'unsold', finalPrice: undefined }),
      );
      expect(notifications.notify).toHaveBeenCalledTimes(1);
      expect(notifications.notify).toHaveBeenCalledWith(
        sellerId.toString(),
        expect.objectContaining({ type: 'unsold' }),
      );
    });

    it('이미 정산됐거나 아직 안 끝난 경매는 건드리지 않는다', async () => {
      auctions.findOne.mockReturnValue(exec(null));
      expect(await service.settle(oid())).toBe(false);
      expect(orders.createForAuction).not.toHaveBeenCalled();
      expect(gateway.emitEnded).not.toHaveBeenCalled();
    });

    it('다른 인스턴스가 먼저 확정했다면 알림을 중복 발송하지 않는다', async () => {
      const doc = auctionDoc();
      auctions.findOne.mockReturnValue(exec(doc));
      auctions.findOneAndUpdate.mockReturnValue(exec(null)); // 확정 경합에서 짐

      expect(await service.settle(doc._id)).toBe(false);
      expect(gateway.emitEnded).not.toHaveBeenCalled();
      expect(notifications.notify).not.toHaveBeenCalled();
    });

    it('주문 생성이 실패하면 확정하지 않아 다음 스윕에서 재시도된다', async () => {
      const doc = auctionDoc();
      auctions.findOne.mockReturnValue(exec(doc));
      orders.createForAuction.mockRejectedValue(new Error('db down'));

      await expect(service.settle(doc._id)).rejects.toThrow('db down');
      expect(auctions.findOneAndUpdate).not.toHaveBeenCalled();
    });
  });

  describe('sweep', () => {
    const due = (...docs: { _id: Types.ObjectId }[]) =>
      auctions.find.mockReturnValue({
        limit: () => ({ lean: () => exec(docs.map(({ _id }) => ({ _id }))) }),
      });

    it('종료된 미정산 경매를 모두 정산한다', async () => {
      const [a, b] = [auctionDoc(), auctionDoc()];
      due(a, b);
      auctions.findOne.mockImplementation((q: { _id: Types.ObjectId }) =>
        exec(q._id.equals(a._id) ? a : b),
      );
      auctions.findOneAndUpdate.mockReturnValue(exec({ settledAt: new Date() }));

      expect(await service.sweep()).toBe(2);
      expect(auctions.find.mock.calls[0][0]).toMatchObject({ settledAt: null });
    });

    it('한 경매가 실패해도 나머지는 계속 정산한다', async () => {
      const [a, b] = [auctionDoc(), auctionDoc()];
      due(a, b);
      auctions.findOne.mockImplementation((q: { _id: Types.ObjectId }) =>
        q._id.equals(a._id) ? { exec: () => Promise.reject(new Error('boom')) } : exec(b),
      );
      auctions.findOneAndUpdate.mockReturnValue(exec({ settledAt: new Date() }));

      expect(await service.sweep()).toBe(1);
    });

    it('이전 스윕이 진행 중이면 겹쳐 실행하지 않는다', async () => {
      let release!: () => void;
      auctions.find.mockReturnValue({
        limit: () => ({
          lean: () => ({ exec: () => new Promise<never[]>((r) => (release = () => r([]))) }),
        }),
      });
      const first = service.sweep();
      expect(await service.sweep()).toBe(0);
      expect(auctions.find).toHaveBeenCalledTimes(1);
      release();
      await first;
    });
  });
});
