import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

/**
 * 결제 시도 한 건의 상태.
 *  ready      결제창을 열기 전 (서버가 주문번호/금액을 확정해 둔 상태)
 *  confirming 승인 API를 호출했고 결과를 아직 확정하지 못함 (네트워크 오류 등)
 *  waiting    승인은 됐지만 입금 대기 (가상계좌)
 *  done       결제 완료
 *  failed     승인 거절/실패
 *  canceled   결제 후 취소(환불)됨
 *  expired    결제 없이 오래 방치됨
 */
export type PaymentStatus = 'ready' | 'confirming' | 'waiting' | 'done' | 'failed' | 'canceled' | 'expired';

@Schema({ timestamps: true })
export class Payment {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Order', required: true, index: true })
  orderId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  buyerId: Types.ObjectId;

  /** 토스에 넘기는 주문번호. 결제 시도마다 고유하며 클라이언트에 노출된다. (6~64자, 영문/숫자/-/_/=) */
  @Prop({ required: true, unique: true })
  tossOrderId: string;

  /** 서버가 정한 결제 금액. 클라이언트가 보낸 금액은 이 값과 대조만 한다. */
  @Prop({ required: true, min: 1 })
  amount: number;

  @Prop({
    type: String,
    enum: ['ready', 'confirming', 'waiting', 'done', 'failed', 'canceled', 'expired'],
    default: 'ready',
    index: true,
  })
  status: PaymentStatus;

  @Prop() paymentKey?: string;
  @Prop() method?: string;
  @Prop() approvedAt?: Date;
  @Prop() receiptUrl?: string;

  @Prop({ type: Object })
  failure?: { code: string; message: string };

  /** 결제 완료가 주문(paid)에 반영된 시각. 비어 있으면 대사 작업이 반영을 마무리한다. */
  @Prop({ type: Date, default: null })
  orderSyncedAt?: Date | null;

  @Prop() canceledAt?: Date;
  @Prop() cancelReason?: string;
}

export type PaymentDocument = HydratedDocument<Payment>;
export const PaymentSchema = SchemaFactory.createForClass(Payment);
PaymentSchema.index({ status: 1, updatedAt: 1 });
