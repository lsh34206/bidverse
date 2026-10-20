import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { Auction } from './auction.schema.js';
import { AuctionsService } from './auctions.service.js';

const HOUR = 60 * 60 * 1000;
const sellerId = new Types.ObjectId().toString();
const owner = { id: sellerId, role: 'buyer' };
const stranger = { id: new Types.ObjectId().toString(), role: 'buyer' };

describe('AuctionsService', () => {
  let service: AuctionsService;
  const model = {
    create: vi.fn(),
    findById: vi.fn(),
    deleteOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
  };

  const existing = (bidCount = 0) => ({
    id: new Types.ObjectId().toString(),
    sellerId: new Types.ObjectId(sellerId),
    bidCount,
    startPrice: 1000,
    startsAt: new Date(Date.now() - HOUR),
    endsAt: new Date(Date.now() + HOUR),
  });
  const found = (doc: unknown) =>
    model.findById.mockReturnValue({ populate: vi.fn(), exec: () => Promise.resolve(doc) });

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [AuctionsService, { provide: getModelToken(Auction.name), useValue: model }],
    }).compile();
    service = module.get(AuctionsService);
  });

  describe('create', () => {
    const base = { title: 't', startPrice: 1000 };

    it('종료 시각이 현재 이전이면 거부한다', async () => {
      await expect(
        service.create(owner, { ...base, endsAt: new Date(Date.now() - 1000) }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('30일을 넘는 기간을 거부한다', async () => {
      await expect(
        service.create(owner, { ...base, endsAt: new Date(Date.now() + 31 * 24 * HOUR) }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('즉시구매가가 시작가 이하이면 거부한다', async () => {
      await expect(
        service.create(owner, { ...base, buyNowPrice: 1000, endsAt: new Date(Date.now() + HOUR) }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('update / remove', () => {
    it('다른 사용자는 수정할 수 없다', async () => {
      found(existing());
      await expect(service.update(stranger, 'b'.repeat(24), { title: 'n' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('입찰이 있으면 수정할 수 없다', async () => {
      found(existing(3));
      await expect(service.update(owner, 'a'.repeat(24), { title: 'n' })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('입찰이 있으면 삭제할 수 없다', async () => {
      found(existing(1));
      await expect(service.remove(owner, 'a'.repeat(24))).rejects.toBeInstanceOf(ConflictException);
      expect(model.deleteOne).not.toHaveBeenCalled();
    });

    it('소유자는 입찰 전 경매를 삭제할 수 있다', async () => {
      found(existing());
      model.deleteOne.mockReturnValue({ exec: () => Promise.resolve({ deletedCount: 1 }) });
      await expect(service.remove(owner, 'a'.repeat(24))).resolves.toBeUndefined();
    });
  });
});
