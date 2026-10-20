import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model, QueryFilter } from 'mongoose';
import { Auction } from '../auctions/auction.schema.js';
import type { AuthUser } from '../auth/jwt-auth.guard.js';
import { BidsGateway, type ChatEvent } from '../bids/bids.gateway.js';
import { ChatMessage, ChatMessageDocument } from './chat-message.schema.js';

export const MAX_CHAT_LENGTH = 300;
const MAX_PAGE = 100;

export interface ChatPage {
  /** 오래된 것 → 최근 것 순서 (화면에 그대로 위에서 아래로 그린다) */
  items: ChatEvent[];
  /** 더 오래된 메시지가 남아 있는지 */
  hasMore: boolean;
}

/** 제어문자는 없애고, 줄바꿈은 최대 두 줄까지만 허용한다. */
export function normalizeChatText(raw: string): string {
  return raw
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

@Injectable()
export class ChatService {
  constructor(
    @InjectModel(ChatMessage.name) private readonly messages: Model<ChatMessage>,
    @InjectModel(Auction.name) private readonly auctions: Model<Auction>,
    private readonly gateway: BidsGateway,
  ) {}

  /**
   * 채팅 전송. 종료되었거나 관리자에 의해 중지된 경매에서는 읽기 전용이다.
   * 시작 전 경매에서는 판매자에게 질문할 수 있도록 열어 둔다.
   */
  async send(user: AuthUser, auctionId: string, rawText: string): Promise<ChatEvent> {
    this.assertValidId(auctionId);
    const text = normalizeChatText(rawText);
    if (text.length === 0) throw new BadRequestException('메시지를 입력해 주세요');
    if ([...text].length > MAX_CHAT_LENGTH) {
      throw new BadRequestException(`메시지는 ${MAX_CHAT_LENGTH}자까지 보낼 수 있어요`);
    }

    const auction = await this.auctions
      .findById(auctionId, { sellerId: 1, endsAt: 1, suspended: 1 })
      .lean()
      .exec();
    if (!auction) throw new NotFoundException('경매를 찾을 수 없습니다');
    if (auction.suspended) throw new ConflictException('관리자에 의해 중지된 경매의 채팅은 닫혀 있어요');
    if (auction.endsAt.getTime() <= Date.now()) throw new ConflictException('종료된 경매의 채팅은 읽기만 할 수 있어요');

    const doc = await this.messages.create({
      auctionId,
      userId: user.id,
      nickname: user.nickname,
      text,
      isSeller: String(auction.sellerId) === user.id,
      isAdmin: user.role === 'admin',
    });
    const event = this.toView(doc);
    this.gateway.emitChat(event);
    return event;
  }

  /** 최근 메시지부터 limit 개. before(메시지 id)를 주면 그보다 오래된 것을 돌려준다. */
  async list(auctionId: string, limit = 50, before?: string): Promise<ChatPage> {
    this.assertValidId(auctionId);
    if (before !== undefined && !isValidObjectId(before)) throw new BadRequestException('잘못된 before 값');
    const size = Math.min(Math.max(Math.floor(limit) || 50, 1), MAX_PAGE);

    const filter: QueryFilter<ChatMessage> = { auctionId, deletedAt: null };
    if (before) filter._id = { $lt: before };
    const docs = await this.messages
      .find(filter)
      .sort({ _id: -1 })
      .limit(size + 1)
      .exec();

    const hasMore = docs.length > size;
    return { items: docs.slice(0, size).reverse().map((d) => this.toView(d)), hasMore };
  }

  /** 삭제 권한: 작성자 본인, 그 경매의 판매자, 관리자 */
  async remove(actor: AuthUser, auctionId: string, messageId: string): Promise<void> {
    this.assertValidId(auctionId);
    if (!isValidObjectId(messageId)) throw new NotFoundException('메시지를 찾을 수 없습니다');

    const message = await this.messages.findOne({ _id: messageId, auctionId, deletedAt: null }).exec();
    if (!message) throw new NotFoundException('메시지를 찾을 수 없습니다');

    const isAuthor = message.userId.toString() === actor.id;
    if (!isAuthor && actor.role !== 'admin') {
      const auction = await this.auctions.findById(auctionId, { sellerId: 1 }).lean().exec();
      if (!auction || String(auction.sellerId) !== actor.id) {
        throw new ForbiddenException('이 메시지를 지울 권한이 없어요');
      }
    }

    // 동시에 두 번 지워도 한 번만 처리되고 이벤트도 한 번만 나간다.
    const res = await this.messages
      .updateOne({ _id: messageId, deletedAt: null }, { $set: { deletedAt: new Date(), deletedBy: actor.id } })
      .exec();
    if (res.modifiedCount === 1) this.gateway.emitChatDeleted({ auctionId, messageId });
  }

  private toView(d: ChatMessageDocument): ChatEvent {
    return {
      id: d.id,
      auctionId: d.auctionId.toString(),
      userId: d.userId.toString(),
      nickname: d.nickname,
      text: d.text,
      isSeller: d.isSeller,
      isAdmin: d.isAdmin,
      createdAt: (d as unknown as { createdAt: Date }).createdAt,
    };
  }

  private assertValidId(id: string): void {
    if (!isValidObjectId(id)) throw new BadRequestException('잘못된 경매 ID');
  }
}
