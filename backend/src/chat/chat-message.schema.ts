import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

const NINETY_DAYS = 90 * 24 * 60 * 60;

/** 경매 채팅방의 메시지 한 건 */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class ChatMessage {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Auction', required: true })
  auctionId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  /** 보낸 시점의 닉네임. 조회마다 사용자 컬렉션을 읽지 않으려고 같이 저장한다. */
  @Prop({ required: true })
  nickname: string;

  @Prop({ required: true })
  text: string;

  /** 보낸 시점에 이 경매의 판매자였는지 / 관리자였는지 (화면의 배지용) */
  @Prop({ default: false })
  isSeller: boolean;

  @Prop({ default: false })
  isAdmin: boolean;

  /** 삭제된 메시지는 지우지 않고 표시만 한다 (누가 지웠는지 남긴다). */
  @Prop({ type: Date, default: null })
  deletedAt?: Date | null;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' })
  deletedBy?: Types.ObjectId;
}

export type ChatMessageDocument = HydratedDocument<ChatMessage>;
export const ChatMessageSchema = SchemaFactory.createForClass(ChatMessage);
// 최근 메시지부터 페이지 단위로 읽는 조회용
ChatMessageSchema.index({ auctionId: 1, _id: -1 });
ChatMessageSchema.index({ createdAt: 1 }, { expireAfterSeconds: NINETY_DAYS });
