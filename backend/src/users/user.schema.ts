import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

export type UserRole = 'buyer' | 'seller' | 'admin';
export type UserStatus = 'active' | 'banned';

@Schema({ timestamps: true })
export class User {
  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email: string;

  @Prop({ required: true })
  passwordHash: string;

  @Prop({ required: true, unique: true, trim: true })
  nickname: string;

  @Prop({ type: String, enum: ['buyer', 'seller', 'admin'], default: 'buyer' })
  role: UserRole;

  /** banned면 로그인과 모든 인증 요청이 막힌다. */
  @Prop({ type: String, enum: ['active', 'banned'], default: 'active' })
  status: UserStatus;

  @Prop()
  bannedReason?: string;
}

export type UserDocument = HydratedDocument<User>;
export const UserSchema = SchemaFactory.createForClass(User);
