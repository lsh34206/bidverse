import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

export type OrderStatus = 'pending' | 'paid' | 'shipped' | 'done' | 'refunded';

@Schema({ timestamps: true })
export class Order {
  /** 경매당 주문은 하나. 정산이 중복 실행돼도 주문이 둘로 늘지 않게 유니크로 막는다. */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Auction', required: true, unique: true })
  auctionId: Types.ObjectId;

  @Prop({ required: true })
  title: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, index: true })
  buyerId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, index: true })
  sellerId: Types.ObjectId;

  @Prop({ required: true, min: 1 })
  finalPrice: number;

  @Prop({ type: String, enum: ['pending', 'paid', 'shipped', 'done', 'refunded'], default: 'pending' })
  status: OrderStatus;

  @Prop() paidAt?: Date;
  @Prop() shippedAt?: Date;
  @Prop() completedAt?: Date;
  @Prop() refundedAt?: Date;
}

export type OrderDocument = HydratedDocument<Order>;
export const OrderSchema = SchemaFactory.createForClass(Order);
