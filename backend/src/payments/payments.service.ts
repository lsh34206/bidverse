import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomBytes } from 'node:crypto';
import { Model } from 'mongoose';
import type { AuthUser } from '../auth/jwt-auth.guard.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { OrderDocument, OrderStatus } from '../orders/order.schema.js';
import { OrdersService, type OrderView } from '../orders/orders.service.js';
import type { ConfirmPaymentDto } from './payments.dto.js';
import { customerKeyFor, type PaymentsConfig } from './payments.config.js';
import { Payment, PaymentDocument } from './payment.schema.js';
import { TossApiError, TossClient, TossNetworkError, type TossPayment } from './toss.client.js';

export const PAYMENTS_CONFIG = Symbol('PAYMENTS_CONFIG');

export interface PrepareResult {
  mode: PaymentsConfig['mode'];
  clientKey: string | null;
  customerKey: string;
  /** 토스 결제창에 넘길 주문번호 (우리 주문 id가 아니다) */
  orderId: string;
  orderName: string;
  amount: number;
}

export interface ConfirmResult {
  status: 'paid' | 'waiting_for_deposit';
  order: OrderView;
  receiptUrl?: string;
  virtualAccount?: TossPayment['virtualAccount'];
}

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * 토스페이먼츠 결제 처리.
 *
 * 원칙:
 *  - 금액은 항상 서버가 정한 값(주문 금액)만 믿는다. 클라이언트가 보낸 금액은 대조에만 쓴다.
 *  - 주문을 '결제 완료'로 바꾸는 것은 토스가 DONE을 돌려준 뒤에만 한다.
 *  - 승인 결과를 모르는 상황(타임아웃 등)에서는 실패로 단정하지 않고, 같은 멱등키로 재시도하거나
 *    토스에서 다시 조회해서(reconcile) 확정한다.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectModel(Payment.name) private readonly payments: Model<Payment>,
    private readonly orders: OrdersService,
    private readonly notifications: NotificationsService,
    private readonly toss: TossClient,
    @Inject(PAYMENTS_CONFIG) private readonly config: PaymentsConfig,
  ) {}

  get mode() {
    return this.config.mode;
  }

  // ---------------------------------------------------------------- 결제 준비

  async prepare(user: AuthUser, orderId: string): Promise<PrepareResult> {
    this.assertEnabled();
    const order = await this.orders.findRaw(orderId);
    // 당사자가 아니면 주문이 있는지도 알려 주지 않는다.
    if (!order || order.buyerId.toString() !== user.id) throw new NotFoundException('주문을 찾을 수 없습니다');
    if (order.status !== 'pending') throw new ConflictException('결제 대기 상태의 주문이 아닙니다');

    // 결제창만 열고 닫은 시도가 쌓이지 않도록, 아직 쓰이지 않은 시도가 있으면 재사용한다.
    let attempt: PaymentDocument | null = await this.payments
      .findOneAndUpdate(
        { orderId: order._id, buyerId: user.id, status: 'ready' },
        { $set: { amount: order.finalPrice } },
        { sort: { createdAt: -1 }, returnDocument: 'after' },
      )
      .exec();
    attempt ??= await this.payments.create({
      orderId: order._id,
      buyerId: user.id,
      tossOrderId: `bv_${order.id}_${randomBytes(6).toString('hex')}`,
      amount: order.finalPrice,
    });

    return {
      mode: this.config.mode,
      clientKey: this.config.clientKey ?? null,
      customerKey: customerKeyFor(user.id, this.config.customerKeySecret),
      orderId: attempt.tossOrderId,
      orderName: truncate(order.title, 100),
      amount: attempt.amount,
    };
  }

  // ---------------------------------------------------------------- 결제 승인

  async confirm(user: AuthUser, dto: ConfirmPaymentDto): Promise<ConfirmResult> {
    this.assertEnabled();
    const attempt = await this.payments.findOne({ tossOrderId: dto.orderId }).exec();
    if (!attempt || attempt.buyerId.toString() !== user.id) throw new NotFoundException('결제 정보를 찾을 수 없습니다');

    // 같은 승인 요청이 다시 온 경우(새로고침, 중복 클릭): 이미 끝났다면 그 결과를 돌려준다.
    if (attempt.status === 'done') {
      if (attempt.paymentKey !== dto.paymentKey) throw new ConflictException('이미 다른 결제로 처리된 주문입니다');
      return this.resultFor(user, attempt, 'paid');
    }
    if (attempt.status === 'waiting') return this.resultFor(user, attempt, 'waiting_for_deposit');
    if (attempt.status === 'failed' || attempt.status === 'canceled' || attempt.status === 'expired') {
      throw new ConflictException('이미 종료된 결제 요청입니다. 다시 결제를 시작해 주세요');
    }

    // 클라이언트 값은 믿지 않는다: 서버가 저장해 둔 금액과 다르면 토스에 승인 요청조차 보내지 않는다.
    if (dto.amount !== attempt.amount) {
      this.logger.warn(
        `결제 금액 불일치 attempt=${attempt.id} user=${user.id} expected=${attempt.amount} got=${dto.amount}`,
      );
      throw new BadRequestException('결제 금액이 주문 금액과 일치하지 않습니다');
    }
    const order = await this.orders.findRaw(attempt.orderId.toString());
    if (!order || order.status !== 'pending') throw new ConflictException('결제 대기 상태의 주문이 아닙니다');

    await this.payments
      .updateOne(
        { _id: attempt._id, status: { $in: ['ready', 'confirming'] } },
        { $set: { status: 'confirming', paymentKey: dto.paymentKey } },
      )
      .exec();

    let tossPayment: TossPayment;
    try {
      // 멱등키가 같아서 네트워크 오류 뒤에 재시도해도 이중 승인되지 않는다.
      tossPayment = await this.toss.confirm(
        { paymentKey: dto.paymentKey, orderId: attempt.tossOrderId, amount: attempt.amount },
        attempt.id,
      );
    } catch (err) {
      tossPayment = await this.recoverFromConfirmError(attempt, err);
    }
    return this.settle(user, attempt, tossPayment);
  }

  /** 승인 API 오류를 분류한다: 확정 실패면 실패 처리하고 던지고, 이미 승인된 경우에는 조회 결과를 쓴다. */
  private async recoverFromConfirmError(attempt: PaymentDocument, err: unknown): Promise<TossPayment> {
    if (err instanceof TossApiError) {
      if (err.status === 409 && err.code === 'IDEMPOTENT_REQUEST_PROCESSING') {
        throw new ConflictException('결제를 처리하고 있어요. 잠시 후 다시 확인해 주세요');
      }
      if (err.code === 'ALREADY_PROCESSED_PAYMENT') {
        const existing = await this.toss.getByOrderId(attempt.tossOrderId);
        if (existing) return existing;
      }
      if (err.status >= 400 && err.status < 500) {
        await this.markFailed(attempt, err.code, err.message);
        throw new BadRequestException(`${err.message} (${err.code})`);
      }
    }
    // 5xx / 타임아웃 / 연결 실패: 승인됐는지 알 수 없다. 실패로 확정하지 않고 'confirming'으로 두면
    // 사용자의 재시도(같은 멱등키)나 reconcile 작업이 결과를 확정한다.
    this.logger.error(
      `결제 승인 결과 불명 attempt=${attempt.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw new ServiceUnavailableException(
      err instanceof TossNetworkError || err instanceof TossApiError
        ? '결제 승인 결과를 확인하지 못했어요. 잠시 후 다시 시도하면 중복 결제 없이 이어서 처리돼요'
        : '결제 처리 중 오류가 발생했어요',
    );
  }

  /** 토스가 돌려준 결제 결과를 주문에 반영한다. 여러 번 불려도 안전하다. */
  private async settle(user: AuthUser | null, attempt: PaymentDocument, toss: TossPayment): Promise<ConfirmResult> {
    // 토스 응답이 우리가 보낸 값과 다르면 승인된 결제라도 되돌린다.
    if (toss.orderId !== attempt.tossOrderId || toss.totalAmount !== attempt.amount) {
      this.logger.error(`토스 응답 불일치 attempt=${attempt.id} toss=${toss.orderId}/${toss.totalAmount}`);
      await this.cancelQuietly(attempt, toss.paymentKey, '결제 정보 불일치로 자동 취소');
      await this.markFailed(attempt, 'MISMATCH', '결제 정보가 일치하지 않습니다');
      throw new ConflictException('결제 정보가 일치하지 않아 취소했어요');
    }

    if (toss.status === 'WAITING_FOR_DEPOSIT') {
      await this.payments
        .updateOne(
          { _id: attempt._id, status: { $in: ['ready', 'confirming'] } },
          { $set: { status: 'waiting', paymentKey: toss.paymentKey, method: toss.method } },
        )
        .exec();
      const fresh = await this.payments.findById(attempt._id).exec();
      return { ...(await this.resultFor(user, fresh ?? attempt, 'waiting_for_deposit')), virtualAccount: toss.virtualAccount };
    }
    if (toss.status !== 'DONE') {
      await this.markFailed(attempt, toss.status, `결제가 완료되지 않았습니다 (${toss.status})`);
      throw new ConflictException('결제가 완료되지 않았어요');
    }

    const done = await this.payments
      .findOneAndUpdate(
        { _id: attempt._id, status: { $in: ['ready', 'confirming', 'waiting', 'done'] } },
        {
          $set: {
            status: 'done',
            paymentKey: toss.paymentKey,
            method: toss.method,
            approvedAt: toss.approvedAt ? new Date(toss.approvedAt) : new Date(),
            receiptUrl: toss.receipt?.url,
          },
        },
        { returnDocument: 'after' },
      )
      .exec();
    if (!done) throw new ConflictException('이미 종료된 결제 요청입니다');

    const paid = await this.orders.markPaid(attempt.orderId.toString());
    if (paid) {
      await this.payments.updateOne({ _id: attempt._id }, { $set: { orderSyncedAt: new Date() } }).exec();
      await this.notifications.notify(paid.sellerId.toString(), {
        type: 'paid',
        auctionId: paid.auctionId.toString(),
        title: paid.title,
        amount: paid.finalPrice,
        orderId: paid.id,
      });
    } else {
      // 주문이 이미 pending이 아니다. 같은 주문에 대한 다른 결제가 먼저 반영됐다면 이 결제는 중복이라 취소한다.
      const other = await this.payments
        .findOne({ orderId: attempt.orderId, status: 'done', _id: { $ne: attempt._id } })
        .exec();
      const order = await this.orders.findRaw(attempt.orderId.toString());
      if (other || !order || order.status === 'refunded') {
        await this.cancelQuietly(done, toss.paymentKey, '중복 결제 또는 주문 상태 변경으로 자동 취소');
        await this.payments.updateOne({ _id: attempt._id, status: 'done' }, { $set: { status: 'canceled', canceledAt: new Date(), cancelReason: '자동 취소' } }).exec();
        throw new ConflictException('이미 처리된 주문이라 이 결제는 취소했어요');
      }
      // 주문은 이미 결제 완료인데 이 결제가 유일한 완료 결제 → 이전에 반영하다 끊긴 것. 정상으로 본다.
      await this.payments.updateOne({ _id: attempt._id }, { $set: { orderSyncedAt: new Date() } }).exec();
    }
    return this.resultFor(user, done, 'paid');
  }

  private async resultFor(user: AuthUser | null, attempt: PaymentDocument, status: ConfirmResult['status']): Promise<ConfirmResult> {
    const orderId = attempt.orderId.toString();
    const order = user
      ? await this.orders.findOne(user, orderId)
      : ({ id: orderId } as OrderView); // 웹훅/작업에서는 응답을 쓰지 않는다
    return { status, order, receiptUrl: attempt.receiptUrl };
  }

  // ---------------------------------------------------------------- 환불

  /** 구매자는 발송 전(paid)에만, 관리자는 결제 이후 어느 단계에서든 전액 환불할 수 있다. */
  async refund(actor: AuthUser, orderId: string, reason: string): Promise<OrderView> {
    this.assertEnabled();
    const order = await this.orders.findRaw(orderId);
    const isAdmin = actor.role === 'admin';
    if (!order || (!isAdmin && order.buyerId.toString() !== actor.id)) {
      throw new NotFoundException('주문을 찾을 수 없습니다');
    }
    const allowed: OrderStatus[] = isAdmin ? ['paid', 'shipped', 'done'] : ['paid'];
    if (!allowed.includes(order.status)) {
      throw new ConflictException(
        isAdmin ? '환불할 수 있는 상태의 주문이 아닙니다' : '발송 전 결제 완료 상태에서만 직접 취소할 수 있어요',
      );
    }
    const attempt = await this.payments.findOne({ orderId: order._id, status: 'done' }).exec();
    if (!attempt?.paymentKey) throw new ConflictException('환불할 결제 내역이 없습니다');

    await this.cancelPayment(attempt, reason);
    const refunded = await this.orders.markRefunded(orderId, allowed);
    const current = refunded ?? (await this.orders.findRaw(orderId));
    await this.notifyRefund(current ?? order, reason);
    // 구매자는 갱신된 주문을 그대로 받고, 당사자가 아닌 관리자는 최소 정보만 받는다.
    return order.buyerId.toString() === actor.id
      ? this.orders.findOne(actor, orderId)
      : ({ id: orderId, status: 'refunded' } as unknown as OrderView);
  }

  /** 토스에 취소를 요청하고 결제 시도를 canceled로 바꾼다. 이미 취소된 결제는 성공으로 본다. */
  private async cancelPayment(attempt: PaymentDocument, reason: string): Promise<void> {
    try {
      await this.toss.cancel(attempt.paymentKey!, reason, `cancel-${attempt.id}`);
    } catch (err) {
      if (err instanceof TossApiError && err.code === 'ALREADY_CANCELED_PAYMENT') {
        // 이미 토스에서는 취소돼 있다 — 우리 쪽 상태만 맞추면 된다.
      } else if (err instanceof TossApiError && err.status >= 400 && err.status < 500) {
        throw new BadRequestException(`환불에 실패했어요: ${err.message} (${err.code})`);
      } else {
        this.logger.error(`환불 결과 불명 attempt=${attempt.id}: ${(err as Error).message}`);
        throw new ServiceUnavailableException('환불 결과를 확인하지 못했어요. 잠시 후 다시 시도해 주세요');
      }
    }
    await this.payments
      .updateOne(
        { _id: attempt._id, status: 'done' },
        { $set: { status: 'canceled', canceledAt: new Date(), cancelReason: reason } },
      )
      .exec();
  }

  private async notifyRefund(order: OrderDocument, reason: string) {
    const base = { type: 'refunded' as const, auctionId: order.auctionId.toString(), title: order.title, amount: order.finalPrice, orderId: order.id, message: reason };
    await Promise.all([
      this.notifications.notify(order.buyerId.toString(), base),
      this.notifications.notify(order.sellerId.toString(), base),
    ]);
  }

  // ---------------------------------------------------------------- 웹훅 / 대사(reconcile)

  /**
   * 토스 웹훅. 페이로드는 신뢰하지 않고, orderId만 뽑아 토스에 다시 조회해서(우리 시크릿 키로)
   * 그 결과로만 상태를 바꾼다. 그래서 위조된 웹훅으로는 아무것도 바꿀 수 없다.
   * 토스는 2xx가 아니면 재전송하므로 처리 중 오류가 나도 호출자에게는 항상 정상 응답을 준다.
   */
  async handleWebhook(payload: unknown): Promise<void> {
    const body = payload as { data?: { orderId?: unknown }; orderId?: unknown } | null;
    const orderId = body?.data?.orderId ?? body?.orderId;
    if (typeof orderId !== 'string' || !/^[A-Za-z0-9_=-]{6,64}$/.test(orderId)) return;
    try {
      const attempt = await this.payments.findOne({ tossOrderId: orderId }).exec();
      if (attempt) await this.reconcileAttempt(attempt);
    } catch (err) {
      this.logger.error(`webhook 처리 실패 orderId=${orderId}: ${(err as Error).message}`);
    }
  }

  /** 토스의 실제 상태를 조회해서 우리 기록을 맞춘다. 웹훅과 주기 작업이 같이 쓴다. */
  async reconcileAttempt(attempt: PaymentDocument): Promise<void> {
    if (this.config.mode === 'off') return;
    const remote = await this.toss.getByOrderId(attempt.tossOrderId);
    if (!remote) {
      // 승인 요청을 보냈다고 기록했지만 토스에는 결제가 없다 = 실제로 결제되지 않았다.
      if (attempt.status === 'confirming') await this.markFailed(attempt, 'NOT_FOUND', '토스에 결제 내역이 없습니다');
      return;
    }
    switch (remote.status) {
      case 'DONE':
      case 'WAITING_FOR_DEPOSIT':
        // 이미 완료로 반영이 끝난 결제는 건드릴 필요가 없다.
        if (!(attempt.status === 'done' && attempt.orderSyncedAt)) {
          await this.settle(null, attempt, remote).catch((err) => {
            if (!(err instanceof ConflictException)) throw err;
          });
        }
        break;
      case 'CANCELED':
      case 'PARTIAL_CANCELED':
        if (attempt.status === 'done') {
          await this.payments
            .updateOne({ _id: attempt._id, status: 'done' }, { $set: { status: 'canceled', canceledAt: new Date(), cancelReason: '토스에서 취소됨' } })
            .exec();
          const refunded = await this.orders.markRefunded(attempt.orderId.toString(), ['paid', 'shipped', 'done']);
          if (refunded) await this.notifyRefund(refunded, '결제가 취소되었습니다');
        }
        break;
      case 'ABORTED':
      case 'EXPIRED':
        if (attempt.status !== 'done') await this.markFailed(attempt, remote.status, '결제가 승인되지 않고 종료되었습니다');
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------- 내부 도우미

  private assertEnabled() {
    if (this.config.mode === 'off') {
      throw new ServiceUnavailableException('결제 기능이 아직 준비되지 않았어요');
    }
  }

  private async markFailed(attempt: PaymentDocument, code: string, message: string) {
    await this.payments
      .updateOne(
        { _id: attempt._id, status: { $in: ['ready', 'confirming', 'waiting'] } },
        { $set: { status: 'failed', failure: { code, message } } },
      )
      .exec();
  }

  /** 자동 취소처럼 실패해도 흐름을 막지 않아야 하는 취소 */
  private async cancelQuietly(attempt: PaymentDocument, paymentKey: string | undefined, reason: string) {
    if (!paymentKey) return;
    try {
      await this.toss.cancel(paymentKey, reason, `auto-cancel-${attempt.id}`);
    } catch (err) {
      this.logger.error(`자동 취소 실패 attempt=${attempt.id}: ${(err as Error).message} — 수동 확인 필요`);
    }
  }
}
