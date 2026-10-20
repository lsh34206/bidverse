import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Auction, AuctionResult } from '../auctions/auction.schema.js';
import { SETTLE_INTERVAL_MS } from '../auctions/auction.constants.js';
import { BidsGateway } from '../bids/bids.gateway.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { OrdersService } from '../orders/orders.service.js';
import { UsersService } from '../users/users.service.js';

const SWEEP_BATCH = 100;

/**
 * 종료 시각이 지난 경매를 낙찰/유찰로 확정한다.
 *
 * 폴링 방식이라 서버가 꺼져 있던 동안 끝난 경매도 다음 기동 때 자동으로 정산된다.
 * 각 단계가 멱등이어서 서버가 여러 대여도, 중간에 죽어도 안전하다.
 *  1) 주문은 경매당 하나만 생기도록 upsert
 *  2) `settledAt`을 조건부로 찍는 데 성공한 쪽만 알림을 보낸다
 */
@Injectable()
export class SettlementService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SettlementService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @InjectModel(Auction.name) private readonly auctions: Model<Auction>,
    private readonly orders: OrdersService,
    private readonly users: UsersService,
    private readonly gateway: BidsGateway,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    if (process.env.DISABLE_SCHEDULERS === 'true') return;
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), SETTLE_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** 정산 대상을 한 번 훑는다. 이전 실행이 안 끝났으면 건너뛴다. */
  async sweep(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const due = await this.auctions
        .find({ settledAt: null, suspended: { $ne: true }, endsAt: { $lte: now } }, { _id: 1 })
        .limit(SWEEP_BATCH)
        .lean()
        .exec();
      let settled = 0;
      for (const { _id } of due) {
        try {
          if (await this.settle(_id, now)) settled++;
        } catch (err) {
          this.logger.error(
            `settle failed auction=${String(_id)}`,
            err instanceof Error ? err.stack : String(err),
          );
        }
      }
      return settled;
    } catch (err) {
      this.logger.error('settlement sweep failed', err instanceof Error ? err.stack : String(err));
      return 0;
    } finally {
      this.running = false;
    }
  }

  /** 경매 하나를 정산한다. 이번 호출이 확정을 맡았으면 true. */
  async settle(auctionId: Types.ObjectId | string, now = new Date()): Promise<boolean> {
    const auction = await this.auctions
      .findOne({ _id: auctionId, settledAt: null, suspended: { $ne: true }, endsAt: { $lte: now } })
      .exec();
    if (!auction) return false;

    const winnerId = auction.highestBidderId;
    const result: AuctionResult = winnerId ? 'sold' : 'unsold';

    const order = winnerId
      ? await this.orders.createForAuction({
          auctionId: auction._id,
          title: auction.title,
          buyerId: winnerId,
          sellerId: auction.sellerId,
          finalPrice: auction.currentPrice,
        })
      : null;

    const marked = await this.auctions
      .findOneAndUpdate(
        // 정산 도중 관리자가 중지했다면 확정하지 않는다.
        { _id: auction._id, settledAt: null, suspended: { $ne: true } },
        { $set: { settledAt: now, result } },
        { returnDocument: 'after' },
      )
      .exec();
    if (!marked) return false; // 다른 인스턴스가 먼저 확정했다.

    await this.announce(auction, result, order?.id);
    return true;
  }

  private async announce(auction: Auction & { id: string }, result: AuctionResult, orderId?: string) {
    const auctionId = auction.id;
    const winner = auction.highestBidderId
      ? await this.users.findById(auction.highestBidderId.toString()).catch(() => null)
      : null;

    this.gateway.emitEnded({
      auctionId,
      result,
      winner: winner ? `${[...winner.nickname][0] ?? '?'}***` : undefined,
      finalPrice: result === 'sold' ? auction.currentPrice : undefined,
    });

    const base = { auctionId, title: auction.title, orderId };
    if (result === 'sold' && auction.highestBidderId) {
      await this.notifications.notify(auction.highestBidderId.toString(), {
        ...base,
        type: 'won',
        amount: auction.currentPrice,
      });
      await this.notifications.notify(auction.sellerId.toString(), {
        ...base,
        type: 'sold',
        amount: auction.currentPrice,
      });
    } else {
      await this.notifications.notify(auction.sellerId.toString(), { ...base, type: 'unsold' });
    }
  }
}
