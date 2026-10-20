import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class Watch {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Auction', required: true, index: true })
  auctionId: Types.ObjectId;
}

export type WatchDocument = HydratedDocument<Watch>;
export const WatchSchema = SchemaFactory.createForClass(Watch);
// 같은 경매를 두 번 담지 못하게 한다.
WatchSchema.index({ userId: 1, auctionId: 1 }, { unique: true });
WatchSchema.index({ userId: 1, createdAt: -1 });
