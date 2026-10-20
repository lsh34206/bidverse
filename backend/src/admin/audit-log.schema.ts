import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

/** 관리자가 한 조치의 기록. 누가, 무엇을, 누구/무엇에게 했는지 남긴다. */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class AuditLog {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  adminId: Types.ObjectId;

  @Prop({ required: true })
  action: string;

  @Prop({ required: true })
  targetType: 'auction' | 'user' | 'report';

  @Prop({ required: true })
  targetId: string;

  @Prop({ type: Object })
  detail?: Record<string, unknown>;
}

export type AuditLogDocument = HydratedDocument<AuditLog>;
export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);
AuditLogSchema.index({ createdAt: -1 });
