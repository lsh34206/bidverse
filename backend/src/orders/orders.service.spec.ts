import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { Order } from './order.schema.js';
import { OrdersService } from './orders.service.js';

const oid = () => new Types.ObjectId();

/** populate가 붙은 find/findById/findOneAndUpdate 체인을 흉내 낸다. */
const chain = <T>(value: T) => {
  const q: Record<string, unknown> = {};
  q.populate = () => q;
  q.sort = () => q;
  q.exec = () => Promise.resolve(value);
  return q;
};

describe('OrdersService', () => {
  let service: OrdersService;
  const model = { findOneAndUpdate: vi.fn(), findById: vi.fn(), find: vi.fn() };

  const buyer = { id: oid().toString(), role: 'buyer' };
  const seller = { id: oid().toString(), role: 'buyer' };
  const stranger = { id: oid().toString(), role: 'buyer' };

  const orderDoc = (status = 'pending') => ({
    id: oid().toString(),
    auctionId: oid(),
    title: '시계',
    finalPrice: 5000,
    status,
    buyerId: { _id: new Types.ObjectId(buyer.id), nickname: 'kim' },
    sellerId: { _id: new Types.ObjectId(seller.id), nickname: 'lee' },
    createdAt: new Date(),
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [OrdersService, { provide: getModelToken(Order.name), useValue: model }],
    }).compile();
    service = module.get(OrdersService);
  });

  it('주문 생성은 auctionId 기준 upsert라 중복 실행돼도 하나만 만들어진다', async () => {
    model.findOneAndUpdate.mockReturnValue(chain({ id: 'o1' }));
    const data = {
      auctionId: oid(),
      title: 't',
      buyerId: oid(),
      sellerId: oid(),
      finalPrice: 100,
    };
    await service.createForAuction(data);
    const [filter, update, options] = model.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ auctionId: data.auctionId });
    expect(update.$setOnInsert).toMatchObject({ ...data, status: 'pending' });
    expect(options.upsert).toBe(true);
  });

  describe('상태 전이', () => {
    it('판매자가 발송하면 paid → shipped, 구매자가 확인하면 shipped → done', async () => {
      const paid = orderDoc('paid');
      model.findById.mockReturnValue(chain(paid));
      model.findOneAndUpdate.mockReturnValue(chain({ ...paid, status: 'shipped' }));
      expect((await service.advance(seller, paid.id, 'ship')).role).toBe('seller');
      expect(model.findOneAndUpdate.mock.calls[0][0].status).toBe('paid');

      const shipped = orderDoc('shipped');
      model.findById.mockReturnValue(chain(shipped));
      model.findOneAndUpdate.mockReturnValue(chain({ ...shipped, status: 'done' }));
      await service.advance(buyer, shipped.id, 'confirm');
      expect(model.findOneAndUpdate.mock.calls[1][0].status).toBe('shipped');
      expect(model.findOneAndUpdate.mock.calls[1][1].$set.status).toBe('done');
    });

    it('역할이 다르면 403 (구매자가 발송, 판매자가 수령 확인)', async () => {
      const doc = orderDoc();
      model.findById.mockReturnValue(chain(doc));
      await expect(service.advance(seller, doc.id, 'confirm')).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.advance(buyer, doc.id, 'ship')).rejects.toBeInstanceOf(ForbiddenException);
      expect(model.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('당사자가 아니면 주문 존재 자체를 숨긴다(404)', async () => {
      const doc = orderDoc();
      model.findById.mockReturnValue(chain(doc));
      await expect(service.advance(stranger, doc.id, 'ship')).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.findOne(stranger, doc.id)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('이미 진행된 단계를 다시 누르면 409', async () => {
      const doc = orderDoc('paid');
      model.findById.mockReturnValue(chain(doc));
      model.findOneAndUpdate.mockReturnValue(chain(null)); // 조건 불일치
      await expect(service.advance(seller, doc.id, 'ship')).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('결제 반영 (PaymentsService 전용)', () => {
    it('markPaid 는 결제 대기(pending) 주문만 paid 로 바꾼다', async () => {
      model.findOneAndUpdate.mockReturnValue(chain({ status: 'paid' }));
      await service.markPaid('o1');
      const [filter, update] = model.findOneAndUpdate.mock.calls[0];
      expect(filter).toEqual({ _id: 'o1', status: 'pending' });
      expect(update.$set.status).toBe('paid');
      expect(update.$set.paidAt).toBeInstanceOf(Date);
    });

    it('markRefunded 는 허용한 상태에서만 refunded 로 바꾼다', async () => {
      model.findOneAndUpdate.mockReturnValue(chain({ status: 'refunded' }));
      await service.markRefunded('o1', ['paid']);
      const [filter, update] = model.findOneAndUpdate.mock.calls[0];
      expect(filter).toEqual({ _id: 'o1', status: { $in: ['paid'] } });
      expect(update.$set.status).toBe('refunded');
    });

    it('더 이상 결제 단계(pay)로 직접 전이할 수 없다', async () => {
      const doc = orderDoc('pending');
      model.findById.mockReturnValue(chain(doc));
      await expect(service.advance(buyer, doc.id, 'pay' as never)).rejects.toThrow();
      expect(model.findOneAndUpdate).not.toHaveBeenCalled();
    });
  });

  it('내 주문 목록에서 구매/판매 역할을 구분해 준다', async () => {
    const doc = orderDoc();
    model.find.mockReturnValue(chain([doc]));
    expect((await service.listMine(buyer))[0].role).toBe('buyer');
    expect((await service.listMine(seller))[0].role).toBe('seller');
    expect((await service.listMine(buyer))[0].buyer.nickname).toBe('kim');
  });
});
