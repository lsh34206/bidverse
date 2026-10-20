import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class Bid {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Auction', required: true })
  auctionId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, index: true })
  bidderId: Types.ObjectId;

  /** 입찰 시점의 닉네임. 입찰 내역 조회에서 사용자 컬렉션을 따로 읽지 않으려고 같이 저장한다. */
  @Prop()
  bidderNickname?: string;

  @Prop({ required: true, min: 1 })
  amount: number;
}

export type BidDocument = HydratedDocument<Bid>;
export const BidSchema = SchemaFactory.createForClass(Bid);
BidSchema.index({ auctionId: 1, amount: -1 });
