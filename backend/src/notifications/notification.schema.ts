import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

export const NOTIFICATION_TYPES = [
  'outbid',
  'won',
  'sold',
  'unsold',
  'ending',
  'suspended',
  'restored',
  'paid',
  'refunded',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

const NINETY_DAYS = 90 * 24 * 60 * 60;

@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class Notification {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ type: String, enum: NOTIFICATION_TYPES, required: true })
  type: NotificationType;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Auction', required: true })
  auctionId: Types.ObjectId;

  @Prop({ required: true })
  title: string;

  @Prop()
  amount?: number;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Order' })
  orderId?: Types.ObjectId;

  @Prop()
  message?: string;

  @Prop({ type: Date, default: null })
  readAt?: Date | null;
}

export type NotificationDocument = HydratedDocument<Notification>;
export const NotificationSchema = SchemaFactory.createForClass(Notification);
NotificationSchema.index({ userId: 1, createdAt: -1 });
NotificationSchema.index({ userId: 1, readAt: 1 });
// 오래된 알림은 자동으로 지운다.
NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: NINETY_DAYS });
