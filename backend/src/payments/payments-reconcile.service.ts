import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { NotificationsService } from '../notifications/notifications.service.js';
import { OrdersService } from '../orders/orders.service.js';
import { Payment } from './payment.schema.js';
import { PaymentsService } from './payments.service.js';

const INTERVAL_MS = 60_000;
const ORPHAN_AFTER_MS = 30_000; // 결제 완료 처리 중인 정상 요청과 겹치지 않도록 잠깐 둔다
const CONFIRMING_AFTER_MS = 2 * 60_000;
const WAITING_RECHECK_AFTER_MS = 10 * 60_000;
const READY_EXPIRE_AFTER_MS = 24 * 60 * 60_000;

/**
 * 결제 기록과 주문 상태, 토스의 실제 상태가 어긋난 건을 주기적으로 바로잡는다.
 * 돈이 오가는 부분이라 "서버가 중간에 죽거나 응답이 끊겨도 결국 맞아진다"를 보장하려는 안전망이다.
 * 모든 단계가 멱등이고 조건부 갱신이라 여러 인스턴스가 동시에 돌려도 안전하다.
 */
@Injectable()
export class PaymentsReconcileService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentsReconcileService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @InjectModel(Payment.name) private readonly payments: Model<Payment>,
    private readonly paymentsService: PaymentsService,
    private readonly orders: OrdersService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    if (process.env.DISABLE_SCHEDULERS === 'true') return;
    this.timer = setInterval(() => void this.sweep(), INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** 바로잡은 건수를 돌려준다. */
  async sweep(now = new Date()): Promise<number> {
    if (this.running || this.paymentsService.mode === 'off') return 0;
    this.running = true;
    let fixed = 0;
    try {
      fixed += await this.syncOrphans(now);
      fixed += await this.recheck({ status: 'confirming', updatedAt: { $lt: new Date(now.getTime() - CONFIRMING_AFTER_MS) } });
      fixed += await this.recheck({ status: 'waiting', updatedAt: { $lt: new Date(now.getTime() - WAITING_RECHECK_AFTER_MS) } });
      const expired = await this.payments
        .updateMany(
          { status: 'ready', updatedAt: { $lt: new Date(now.getTime() - READY_EXPIRE_AFTER_MS) } },
          { $set: { status: 'expired' } },
        )
        .exec();
      fixed += expired.modifiedCount;
    } catch (err) {
      this.logger.error('payments reconcile failed', err instanceof Error ? err.stack : String(err));
    } finally {
      this.running = false;
    }
    return fixed;
  }

  /** 결제는 완료로 기록됐는데 주문이 아직 결제 대기인 건: 반영하다 끊긴 것이므로 마저 반영한다. */
  private async syncOrphans(now: Date): Promise<number> {
    const orphans = await this.payments
      .find({ status: 'done', orderSyncedAt: null, updatedAt: { $lt: new Date(now.getTime() - ORPHAN_AFTER_MS) } })
      .limit(50)
      .exec();
    let fixed = 0;
    for (const p of orphans) {
      try {
        const paid = await this.orders.markPaid(p.orderId.toString());
        await this.payments.updateOne({ _id: p._id }, { $set: { orderSyncedAt: new Date() } }).exec();
        if (paid) {
          fixed++;
          this.logger.warn(`고아 결제 복구: payment=${p.id} order=${paid.id}`);
          await this.notifications.notify(paid.sellerId.toString(), {
            type: 'paid',
            auctionId: paid.auctionId.toString(),
            title: paid.title,
            amount: paid.finalPrice,
            orderId: paid.id,
          });
        }
      } catch (err) {
        this.logger.error(`고아 결제 복구 실패 payment=${p.id}: ${(err as Error).message}`);
      }
    }
    return fixed;
  }

  private async recheck(filter: Record<string, unknown>): Promise<number> {
    const stale = await this.payments.find(filter).limit(50).exec();
    let fixed = 0;
    for (const p of stale) {
      try {
        await this.paymentsService.reconcileAttempt(p);
        fixed++;
      } catch (err) {
        this.logger.error(`결제 재확인 실패 payment=${p.id}: ${(err as Error).message}`);
      }
    }
    return fixed;
  }
}
