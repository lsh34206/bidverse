import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

export type ReportStatus = 'open' | 'resolved';
export type ReportResolution = 'suspended' | 'dismissed';

@Schema({ timestamps: true })
export class Report {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Auction', required: true, index: true })
  auctionId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  reporterId: Types.ObjectId;

  @Prop({ required: true })
  reason: string;

  @Prop({ type: String, enum: ['open', 'resolved'], default: 'open', index: true })
  status: ReportStatus;

  @Prop({ type: String, enum: ['suspended', 'dismissed'] })
  resolution?: ReportResolution;

  @Prop()
  note?: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' })
  resolvedBy?: Types.ObjectId;

  @Prop()
  resolvedAt?: Date;
}

export type ReportDocument = HydratedDocument<Report>;
export const ReportSchema = SchemaFactory.createForClass(Report);
// 한 사용자가 같은 경매를 여러 번 신고해 관리자 큐를 채우지 못하게 한다.
ReportSchema.index({ auctionId: 1, reporterId: 1 }, { unique: true });
