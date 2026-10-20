import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model, Types } from 'mongoose';
import type { AuthUser } from '../auth/jwt-auth.guard.js';
import { Order, OrderDocument, OrderStatus } from './order.schema.js';

export interface OrderView {
  id: string;
  auctionId: string;
  title: string;
  finalPrice: number;
  status: OrderStatus;
  /** 요청한 사용자 기준 역할 */
  role: 'buyer' | 'seller';
  buyer: { id: string; nickname: string | null };
  seller: { id: string; nickname: string | null };
  createdAt: Date;
  paidAt: Date | null;
  shippedAt: Date | null;
  completedAt: Date | null;
  refundedAt: Date | null;
}

type Step = {
  from: OrderStatus;
  to: OrderStatus;
  actor: 'buyer' | 'seller';
  stamp: 'paidAt' | 'shippedAt' | 'completedAt';
};

/**
 * 주문 상태 전이: 발송(판매자) → 수령 확인(구매자).
 * 결제(pending → paid)와 환불(→ refunded)은 PaymentsService가 토스 결과를 확인한 뒤에만 바꾼다.
 */
const STEPS = {
  ship: { from: 'paid', to: 'shipped', actor: 'seller', stamp: 'shippedAt' },
  confirm: { from: 'shipped', to: 'done', actor: 'buyer', stamp: 'completedAt' },
} as const satisfies Record<string, Step>;

export type OrderAction = keyof typeof STEPS;

interface PopulatedUser {
  _id: Types.ObjectId;
  nickname?: string;
}

@Injectable()
export class OrdersService {
  constructor(@InjectModel(Order.name) private readonly orders: Model<Order>) {}

  /** 정산에서 호출한다. auctionId 기준으로 멱등이라 여러 번 불려도 주문은 하나만 만들어진다. */
  async createForAuction(data: {
    auctionId: Types.ObjectId;
    title: string;
    buyerId: Types.ObjectId;
    sellerId: Types.ObjectId;
    finalPrice: number;
  }): Promise<OrderDocument> {
    const order = await this.orders
      .findOneAndUpdate(
        { auctionId: data.auctionId },
        { $setOnInsert: { ...data, status: 'pending' } },
        { upsert: true, returnDocument: 'after' },
      )
      .exec();
    return order as OrderDocument;
  }

  /** 결제 모듈이 쓰는 단순 조회 (populate 없음) */
  async findRaw(id: string): Promise<OrderDocument | null> {
    if (!isValidObjectId(id)) return null;
    return this.orders.findById(id).exec();
  }

  /** 결제가 확정됐을 때만 호출된다. 결제 대기(pending) 상태에서만 바뀐다. */
  markPaid(id: string): Promise<OrderDocument | null> {
    return this.orders
      .findOneAndUpdate(
        { _id: id, status: 'pending' },
        { $set: { status: 'paid', paidAt: new Date() } },
        { returnDocument: 'after' },
      )
      .exec();
  }

  /** 환불이 확정됐을 때만 호출된다. from 중 하나의 상태에서만 바뀐다. */
  markRefunded(id: string, from: OrderStatus[]): Promise<OrderDocument | null> {
    return this.orders
      .findOneAndUpdate(
        { _id: id, status: { $in: from } },
        { $set: { status: 'refunded', refundedAt: new Date() } },
        { returnDocument: 'after' },
      )
      .exec();
  }

  async listMine(user: AuthUser): Promise<OrderView[]> {
    const docs = await this.orders
      .find({ $or: [{ buyerId: user.id }, { sellerId: user.id }] })
      .sort({ createdAt: -1 })
      .populate('buyerId', 'nickname')
      .populate('sellerId', 'nickname')
      .exec();
    return docs.map((d) => this.toView(d, user.id));
  }

  async findOne(user: AuthUser, id: string): Promise<OrderView> {
    const doc = await this.load(id);
    this.assertParty(doc, user.id);
    return this.toView(doc, user.id);
  }

  async advance(user: AuthUser, id: string, action: OrderAction): Promise<OrderView> {
    const step: Step = STEPS[action];
    const doc = await this.load(id);
    const party = step.actor === 'buyer' ? doc.buyerId : doc.sellerId;
    this.assertParty(doc, user.id);
    if (!this.isSame(party, user.id)) {
      throw new ForbiddenException(
        step.actor === 'buyer' ? '구매자만 할 수 있습니다' : '판매자만 할 수 있습니다',
      );
    }

    // 현재 상태가 기대한 값일 때만 전이한다 (중복 클릭/동시 요청 방지).
    const updated = await this.orders
      .findOneAndUpdate(
        { _id: id, status: step.from },
        { $set: { status: step.to, [step.stamp]: new Date() } },
        { returnDocument: 'after' },
      )
      .populate('buyerId', 'nickname')
      .populate('sellerId', 'nickname')
      .exec();
    if (!updated) throw new ConflictException('현재 상태에서는 진행할 수 없는 단계입니다');
    return this.toView(updated, user.id);
  }

  private async load(id: string): Promise<OrderDocument> {
    if (!isValidObjectId(id)) throw new BadRequestException('잘못된 주문 ID');
    const doc = await this.orders
      .findById(id)
      .populate('buyerId', 'nickname')
      .populate('sellerId', 'nickname')
      .exec();
    if (!doc) throw new NotFoundException('주문을 찾을 수 없습니다');
    return doc;
  }

  private assertParty(doc: OrderDocument, userId: string): void {
    if (!this.isSame(doc.buyerId, userId) && !this.isSame(doc.sellerId, userId)) {
      // 주문의 존재 여부를 노출하지 않도록 404로 응답한다.
      throw new NotFoundException('주문을 찾을 수 없습니다');
    }
  }

  /** populate된 문서와 ObjectId 모두에서 id를 꺼내 비교한다. */
  private isSame(ref: Types.ObjectId | PopulatedUser, userId: string): boolean {
    return this.idOf(ref) === userId;
  }

  private idOf(ref: Types.ObjectId | PopulatedUser): string {
    return (ref as PopulatedUser)._id ? String((ref as PopulatedUser)._id) : String(ref);
  }

  private toView(doc: OrderDocument, userId: string): OrderView {
    const user = (ref: Types.ObjectId | PopulatedUser) => ({
      id: this.idOf(ref),
      nickname: (ref as PopulatedUser).nickname ?? null,
    });
    return {
      id: doc.id,
      auctionId: String(doc.auctionId),
      title: doc.title,
      finalPrice: doc.finalPrice,
      status: doc.status,
      role: this.isSame(doc.buyerId, userId) ? 'buyer' : 'seller',
      buyer: user(doc.buyerId),
      seller: user(doc.sellerId),
      createdAt: (doc as unknown as { createdAt: Date }).createdAt,
      paidAt: doc.paidAt ?? null,
      shippedAt: doc.shippedAt ?? null,
      completedAt: doc.completedAt ?? null,
      refundedAt: doc.refundedAt ?? null,
    };
  }
}
