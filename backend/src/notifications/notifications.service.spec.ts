import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { BidsGateway } from '../bids/bids.gateway.js';
import { Notification } from './notification.schema.js';
import { NotificationsService } from './notifications.service.js';

const oid = () => new Types.ObjectId();
const exec = <T>(value: T) => ({ exec: () => Promise.resolve(value) });

describe('NotificationsService', () => {
  let service: NotificationsService;
  const model = {
    create: vi.fn(),
    find: vi.fn(),
    countDocuments: vi.fn(),
    updateMany: vi.fn(),
  };
  const gateway = { notifyUser: vi.fn() };
  const userId = oid().toString();
  const auctionId = oid().toString();

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: getModelToken(Notification.name), useValue: model },
        { provide: BidsGateway, useValue: gateway },
      ],
    }).compile();
    service = module.get(NotificationsService);
  });

  describe('notify', () => {
    it('저장한 뒤 저장된 id와 함께 실시간으로 보낸다', async () => {
      model.create.mockResolvedValue({ id: 'n1', createdAt: new Date('2026-01-01') });

      await service.notify(userId, { type: 'outbid', auctionId, title: '시계', amount: 3000 });

      expect(model.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId, type: 'outbid', auctionId, title: '시계', amount: 3000 }),
      );
      expect(gateway.notifyUser).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ id: 'n1', type: 'outbid', amount: 3000 }),
      );
    });

    it('저장이 실패해도 던지지 않고 id 없이 실시간 전송은 한다', async () => {
      model.create.mockRejectedValue(new Error('db down'));

      await expect(
        service.notify(userId, { type: 'won', auctionId, title: '시계' }),
      ).resolves.toBeUndefined();

      const sent = gateway.notifyUser.mock.calls[0][1];
      expect(sent.type).toBe('won');
      expect(sent.id).toBeUndefined();
    });
  });

  describe('목록/읽음', () => {
    it('내 알림만 최신순으로 돌려주고 안 읽은 수를 함께 준다', async () => {
      const doc = {
        id: 'n1',
        type: 'sold',
        auctionId: oid(),
        title: '시계',
        amount: 5000,
        orderId: oid(),
        readAt: null,
        createdAt: new Date(),
      };
      model.find.mockReturnValue({
        sort: () => ({ skip: () => ({ limit: () => exec([doc]) }) }),
      });
      model.countDocuments.mockImplementation((filter: { readAt?: null }) =>
        exec(filter.readAt === null ? 2 : 7),
      );

      const res = await service.list(userId, 1, 20);

      expect(model.find.mock.calls[0][0]).toEqual({ userId });
      expect(res).toMatchObject({ total: 7, unreadCount: 2, page: 1, limit: 20 });
      expect(res.items[0]).toMatchObject({ id: 'n1', read: false, amount: 5000, message: null });
    });

    it('읽음 처리는 항상 userId 조건이 붙어서 남의 알림은 건드리지 못한다', async () => {
      model.updateMany.mockReturnValue(exec({ modifiedCount: 1 }));
      const mine = oid().toString();

      await service.markRead(userId, [mine, 'not-an-id']);

      const [filter, update] = model.updateMany.mock.calls[0];
      expect(filter.userId).toBe(userId);
      expect(filter.readAt).toBeNull();
      expect(filter._id).toEqual({ $in: [mine] }); // 잘못된 id는 걸러진다
      expect(update.$set.readAt).toBeInstanceOf(Date);
    });

    it('ids를 비우면 내 안 읽은 알림 전부를 읽음 처리한다', async () => {
      model.updateMany.mockReturnValue(exec({ modifiedCount: 5 }));
      expect(await service.markRead(userId)).toEqual({ modified: 5 });
      expect(model.updateMany.mock.calls[0][0]).toEqual({ userId, readAt: null });
    });
  });
});
