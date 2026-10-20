import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { Auction } from '../auctions/auction.schema.js';
import { BidsGateway } from '../bids/bids.gateway.js';
import { ChatMessage } from './chat-message.schema.js';
import { ChatService, MAX_CHAT_LENGTH, normalizeChatText } from './chat.service.js';

const HOUR = 60 * 60 * 1000;
const oid = () => new Types.ObjectId();
const exec = <T>(value: T) => ({ exec: () => Promise.resolve(value) });
const lean = <T>(value: T) => ({ lean: () => exec(value) });

describe('normalizeChatText', () => {
  it('앞뒤 공백과 제어문자를 정리하고 빈 줄은 두 줄까지만 둔다', () => {
    expect(normalizeChatText('  안녕\u0000하세요  ')).toBe('안녕하세요');
    expect(normalizeChatText('a\n\n\n\n\nb')).toBe('a\n\nb');
    expect(normalizeChatText('a\r\nb')).toBe('a\nb');
    expect(normalizeChatText('   \n\t ')).toBe('');
  });

  it('이모지와 한글은 그대로 둔다', () => {
    expect(normalizeChatText('입찰 갑니다 🔥')).toBe('입찰 갑니다 🔥');
  });
});

describe('ChatService', () => {
  let service: ChatService;
  const messages = { create: vi.fn(), find: vi.fn(), findOne: vi.fn(), updateOne: vi.fn() };
  const auctions = { findById: vi.fn() };
  const gateway = { emitChat: vi.fn(), emitChatDeleted: vi.fn() };

  const auctionId = oid().toString();
  const sellerId = oid();
  const user = { id: oid().toString(), role: 'buyer', nickname: 'hong' };
  const seller = { id: sellerId.toString(), role: 'buyer', nickname: 'seller' };
  const admin = { id: oid().toString(), role: 'admin', nickname: 'admin' };

  const openAuction = (over: Record<string, unknown> = {}) => ({
    sellerId,
    endsAt: new Date(Date.now() + HOUR),
    suspended: false,
    ...over,
  });
  const msgDoc = (over: Record<string, unknown> = {}) => {
    const _id = oid();
    return {
      _id,
      id: _id.toString(),
      auctionId: new Types.ObjectId(auctionId),
      userId: new Types.ObjectId(user.id),
      nickname: 'hong',
      text: '안녕하세요',
      isSeller: false,
      isAdmin: false,
      createdAt: new Date(),
      ...over,
    };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    messages.create.mockImplementation(async (d) => msgDoc({ ...d, auctionId: new Types.ObjectId(d.auctionId), userId: new Types.ObjectId(d.userId) }));
    const module = await Test.createTestingModule({
      providers: [
        ChatService,
        { provide: getModelToken(ChatMessage.name), useValue: messages },
        { provide: getModelToken(Auction.name), useValue: auctions },
        { provide: BidsGateway, useValue: gateway },
      ],
    }).compile();
    service = module.get(ChatService);
  });

  describe('send', () => {
    it('저장하고 같은 내용을 방 전체에 브로드캐스트한다', async () => {
      auctions.findById.mockReturnValue(lean(openAuction()));

      const res = await service.send(user, auctionId, '  입찰 갑니다  ');

      expect(messages.create).toHaveBeenCalledWith(
        expect.objectContaining({ auctionId, userId: user.id, nickname: 'hong', text: '입찰 갑니다', isSeller: false, isAdmin: false }),
      );
      expect(res).toMatchObject({ text: '입찰 갑니다', nickname: 'hong', auctionId });
      expect(gateway.emitChat).toHaveBeenCalledWith(res);
    });

    it('판매자와 관리자에게는 배지 표시가 붙는다', async () => {
      auctions.findById.mockReturnValue(lean(openAuction()));
      expect((await service.send(seller, auctionId, '문의 주세요')).isSeller).toBe(true);
      expect((await service.send(admin, auctionId, '운영자입니다')).isAdmin).toBe(true);
      expect((await service.send(user, auctionId, '일반')).isSeller).toBe(false);
    });

    it('빈 메시지와 너무 긴 메시지는 거절한다 (한글/이모지는 글자 수로 센다)', async () => {
      auctions.findById.mockReturnValue(lean(openAuction()));
      await expect(service.send(user, auctionId, '   \n ')).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.send(user, auctionId, '가'.repeat(MAX_CHAT_LENGTH + 1))).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.send(user, auctionId, '😀'.repeat(MAX_CHAT_LENGTH))).resolves.toBeDefined();
      expect(gateway.emitChat).toHaveBeenCalledTimes(1);
    });

    it('종료된 경매, 중지된 경매, 없는 경매는 보낼 수 없다', async () => {
      auctions.findById.mockReturnValue(lean(openAuction({ endsAt: new Date(Date.now() - 1000) })));
      await expect(service.send(user, auctionId, '안녕')).rejects.toBeInstanceOf(ConflictException);
      auctions.findById.mockReturnValue(lean(openAuction({ suspended: true })));
      await expect(service.send(user, auctionId, '안녕')).rejects.toBeInstanceOf(ConflictException);
      auctions.findById.mockReturnValue(lean(null));
      await expect(service.send(user, auctionId, '안녕')).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.send(user, 'nope', '안녕')).rejects.toBeInstanceOf(BadRequestException);
      expect(messages.create).not.toHaveBeenCalled();
      expect(gateway.emitChat).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    const page = (docs: unknown[]) =>
      messages.find.mockReturnValue({ sort: () => ({ limit: () => exec(docs) }) });

    it('삭제되지 않은 메시지를 오래된 순으로 돌려주고, 더 있는지 알려 준다', async () => {
      const docs = [msgDoc({ text: '3' }), msgDoc({ text: '2' }), msgDoc({ text: '1' })]; // 최근순으로 limit+1 개
      page(docs);

      const res = await service.list(auctionId, 2);

      expect(messages.find.mock.calls[0][0]).toMatchObject({ auctionId, deletedAt: null });
      expect(res.items.map((m) => m.text)).toEqual(['2', '3']);
      expect(res.hasMore).toBe(true);
    });

    it('before 가 있으면 그보다 오래된 것만 조회한다', async () => {
      page([]);
      const before = oid().toString();
      const res = await service.list(auctionId, 50, before);
      expect(messages.find.mock.calls[0][0]._id).toEqual({ $lt: before });
      expect(res).toEqual({ items: [], hasMore: false });
    });

    it('잘못된 id/before 는 400', async () => {
      await expect(service.list('nope')).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.list(auctionId, 10, 'nope')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('remove', () => {
    const messageId = oid().toString();
    const found = (doc: unknown) => messages.findOne.mockReturnValue(exec(doc));

    it('작성자 본인은 지울 수 있고 삭제 이벤트가 나간다', async () => {
      found(msgDoc());
      messages.updateOne.mockReturnValue(exec({ modifiedCount: 1 }));

      await service.remove(user, auctionId, messageId);

      const [filter, update] = messages.updateOne.mock.calls[0];
      expect(filter).toEqual({ _id: messageId, deletedAt: null });
      expect(update.$set.deletedBy).toBe(user.id);
      expect(gateway.emitChatDeleted).toHaveBeenCalledWith({ auctionId, messageId });
    });

    it('관리자와 그 경매의 판매자는 남의 메시지도 지울 수 있다', async () => {
      found(msgDoc());
      messages.updateOne.mockReturnValue(exec({ modifiedCount: 1 }));
      await service.remove(admin, auctionId, messageId);
      auctions.findById.mockReturnValue(lean({ sellerId }));
      await service.remove(seller, auctionId, messageId);
      expect(gateway.emitChatDeleted).toHaveBeenCalledTimes(2);
    });

    it('관계없는 사용자는 지울 수 없다 (403)', async () => {
      found(msgDoc());
      auctions.findById.mockReturnValue(lean({ sellerId }));
      const stranger = { id: oid().toString(), role: 'buyer', nickname: 'x' };
      await expect(service.remove(stranger, auctionId, messageId)).rejects.toBeInstanceOf(ForbiddenException);
      expect(messages.updateOne).not.toHaveBeenCalled();
    });

    it('없거나 이미 지워진 메시지는 404, 동시에 두 번 지워도 이벤트는 한 번', async () => {
      found(null);
      await expect(service.remove(user, auctionId, messageId)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.remove(user, auctionId, 'nope')).rejects.toBeInstanceOf(NotFoundException);

      found(msgDoc());
      messages.updateOne.mockReturnValue(exec({ modifiedCount: 0 })); // 다른 요청이 먼저 지움
      await service.remove(user, auctionId, messageId);
      expect(gateway.emitChatDeleted).not.toHaveBeenCalled();
    });
  });
});
