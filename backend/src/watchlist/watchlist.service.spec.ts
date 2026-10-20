import { BadRequestException, NotFoundException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { Auction } from '../auctions/auction.schema.js';
import { AuctionsService } from '../auctions/auctions.service.js';
import { Watch } from './watch.schema.js';
import { WatchlistService } from './watchlist.service.js';

const oid = () => new Types.ObjectId();
const exec = <T>(value: T) => ({ exec: () => Promise.resolve(value) });

describe('WatchlistService', () => {
  let service: WatchlistService;
  const watches = { updateOne: vi.fn(), deleteOne: vi.fn(), find: vi.fn() };
  const auctions = { exists: vi.fn() };
  const auctionsService = { viewsByIds: vi.fn() };
  const userId = oid().toString();
  const auctionId = oid().toString();

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        WatchlistService,
        { provide: getModelToken(Watch.name), useValue: watches },
        { provide: getModelToken(Auction.name), useValue: auctions },
        { provide: AuctionsService, useValue: auctionsService },
      ],
    }).compile();
    service = module.get(WatchlistService);
  });

  it('담기는 upsert라서 두 번 눌러도 중복되지 않는다', async () => {
    auctions.exists.mockReturnValue(exec({ _id: auctionId }));
    watches.updateOne.mockReturnValue(exec({}));

    expect(await service.add(userId, auctionId)).toEqual({ watching: true });

    const [filter, , options] = watches.updateOne.mock.calls[0];
    expect(filter).toEqual({ userId, auctionId });
    expect(options.upsert).toBe(true);
  });

  it('없거나 중지된 경매는 담을 수 없다', async () => {
    auctions.exists.mockReturnValue(exec(null));
    await expect(service.add(userId, auctionId)).rejects.toBeInstanceOf(NotFoundException);
    expect(auctions.exists.mock.calls[0][0].suspended).toEqual({ $ne: true });
    expect(watches.updateOne).not.toHaveBeenCalled();
  });

  it('잘못된 id는 400', async () => {
    await expect(service.add(userId, 'nope')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.remove(userId, 'nope')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('빼기는 내 항목만 지운다', async () => {
    watches.deleteOne.mockReturnValue(exec({}));
    expect(await service.remove(userId, auctionId)).toEqual({ watching: false });
    expect(watches.deleteOne).toHaveBeenCalledWith({ userId, auctionId });
  });

  it('목록은 담은 순서(최신순) 그대로 경매를 돌려준다', async () => {
    const [a, b] = [oid(), oid()];
    watches.find.mockReturnValue({
      sort: () => ({ limit: () => ({ lean: () => exec([{ auctionId: a }, { auctionId: b }]) }) }),
    });
    auctionsService.viewsByIds.mockResolvedValue([{ id: a.toString() }]);

    await service.list(userId);

    expect(auctionsService.viewsByIds).toHaveBeenCalledWith([a.toString(), b.toString()]);
  });
});
