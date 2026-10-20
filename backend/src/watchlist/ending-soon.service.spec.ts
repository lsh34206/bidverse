import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { ENDING_SOON_WINDOW_MS } from '../auctions/auction.constants.js';
import { Auction } from '../auctions/auction.schema.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { EndingSoonService } from './ending-soon.service.js';
import { WatchlistService } from './watchlist.service.js';

const oid = () => new Types.ObjectId();
const exec = <T>(value: T) => ({ exec: () => Promise.resolve(value) });

describe('EndingSoonService', () => {
  let service: EndingSoonService;
  const auctions = { find: vi.fn(), findOneAndUpdate: vi.fn() };
  const watchlist = { watcherIds: vi.fn() };
  const notifications = { notify: vi.fn() };

  const sellerId = oid();
  const auction = (over: Record<string, unknown> = {}) => {
    const _id = oid();
    return { _id, id: _id.toString(), sellerId, title: '시계', currentPrice: 4000, ...over };
  };
  const due = (...docs: unknown[]) =>
    auctions.find.mockReturnValue({ limit: () => exec(docs) });

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.DISABLE_SCHEDULERS = 'true';
    const module = await Test.createTestingModule({
      providers: [
        EndingSoonService,
        { provide: getModelToken(Auction.name), useValue: auctions },
        { provide: WatchlistService, useValue: watchlist },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = module.get(EndingSoonService);
  });

  it('마감 1시간 이내, 아직 알리지 않은, 중지되지 않은 경매만 찾는다', async () => {
    due();
    const now = new Date('2026-01-01T12:00:00Z');
    await service.sweep(now);

    const filter = auctions.find.mock.calls[0][0];
    expect(filter.suspended).toEqual({ $ne: true });
    expect(filter.endingSoonNotifiedAt).toBeNull();
    expect(filter.endsAt.$gt).toEqual(now);
    expect(filter.endsAt.$lte).toEqual(new Date(now.getTime() + ENDING_SOON_WINDOW_MS));
  });

  it('관심 등록자에게 알리되 판매자 본인은 제외한다', async () => {
    const a = auction();
    const watcher = oid().toString();
    due(a);
    auctions.findOneAndUpdate.mockReturnValue(exec({ _id: a._id }));
    watchlist.watcherIds.mockResolvedValue([watcher, sellerId.toString()]);

    expect(await service.sweep()).toBe(1);

    expect(notifications.notify).toHaveBeenCalledTimes(1);
    expect(notifications.notify).toHaveBeenCalledWith(
      watcher,
      expect.objectContaining({ type: 'ending', auctionId: a.id, amount: 4000 }),
    );
  });

  it('알림 표시를 조건부로 찍어서, 다른 인스턴스가 먼저 처리했다면 보내지 않는다', async () => {
    const a = auction();
    due(a);
    auctions.findOneAndUpdate.mockReturnValue(exec(null)); // 경합에서 짐

    expect(await service.sweep()).toBe(0);

    expect(auctions.findOneAndUpdate.mock.calls[0][0]).toMatchObject({ endingSoonNotifiedAt: null });
    expect(watchlist.watcherIds).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('한 경매가 실패해도 나머지는 계속 처리한다', async () => {
    const [a, b] = [auction(), auction()];
    due(a, b);
    auctions.findOneAndUpdate.mockReturnValue(exec({}));
    watchlist.watcherIds.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([oid().toString()]);

    expect(await service.sweep()).toBe(1);
    expect(notifications.notify).toHaveBeenCalledTimes(1);
  });
});
