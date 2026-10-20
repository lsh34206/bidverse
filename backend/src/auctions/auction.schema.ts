import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

export type AuctionStatus = 'scheduled' | 'live' | 'ended';
export type AuctionResult = 'sold' | 'unsold';

@Schema({ timestamps: true })
export class Auction {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, index: true })
  sellerId: Types.ObjectId;

  /** 등록 시점의 판매자 닉네임. 경매 조회마다 사용자 컬렉션을 따로 읽지 않으려고 같이 저장한다. */
  @Prop()
  sellerNickname?: string;

  @Prop({ required: true, trim: true })
  title: string;

  @Prop({ default: '' })
  description: string;

  @Prop({ default: 'etc', index: true })
  category: string;

  @Prop({ type: [String], default: [] })
  images: string[];

  @Prop({ required: true, min: 1 })
  startPrice: number;

  @Prop({ required: true, min: 1 })
  currentPrice: number;

  @Prop({ required: true, min: 1, default: 1000 })
  minIncrement: number;

  @Prop()
  buyNowPrice?: number;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' })
  highestBidderId?: Types.ObjectId;

  @Prop({ default: 0 })
  bidCount: number;

  @Prop({ required: true })
  startsAt: Date;

  @Prop({ required: true, index: true })
  endsAt: Date;

  /** 스나이핑 방지로 종료 시각이 연장된 횟수 */
  @Prop({ default: 0 })
  extensionCount: number;

  /** 낙찰/유찰 정산이 끝난 시각. 비어 있으면 아직 정산 전이다. */
  @Prop({ type: Date, default: null })
  settledAt?: Date | null;

  @Prop({ type: String, enum: ['sold', 'unsold'] })
  result?: AuctionResult;

  /** 관리자가 중지한 경매: 목록에서 숨기고 입찰·정산을 막는다. */
  @Prop({ default: false })
  suspended: boolean;

  @Prop()
  suspendedReason?: string;

  /** 종료 임박 알림을 보낸 시각 (경매당 한 번만 보내기 위한 표시) */
  @Prop({ type: Date, default: null })
  endingSoonNotifiedAt?: Date | null;
}

export type AuctionDocument = HydratedDocument<Auction>;
export const AuctionSchema = SchemaFactory.createForClass(Auction);
AuctionSchema.index({ title: 'text' });
AuctionSchema.index({ settledAt: 1, endsAt: 1 });
