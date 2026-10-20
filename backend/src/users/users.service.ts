import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model, QueryFilter } from 'mongoose';
import { User, UserDocument, UserRole, UserStatus } from './user.schema.js';

/** 인증 가드용 사용자 요약 */
export interface AuthSnapshot {
  id: string;
  role: UserRole;
  status: UserStatus;
  nickname: string;
}

const AUTH_CACHE_TTL_MS = 5_000;
const AUTH_CACHE_MAX = 5_000;

@Injectable()
export class UsersService {
  private readonly authCache = new Map<string, { snapshot: AuthSnapshot; expiresAt: number }>();

  constructor(@InjectModel(User.name) private readonly users: Model<User>) {}

  create(data: Pick<User, 'email' | 'passwordHash' | 'nickname'>): Promise<UserDocument> {
    return this.users.create(data);
  }

  findByEmail(email: string): Promise<UserDocument | null> {
    return this.users.findOne({ email: email.toLowerCase() }).exec();
  }

  findById(id: string): Promise<UserDocument | null> {
    if (!isValidObjectId(id)) return Promise.resolve(null);
    return this.users.findById(id).exec();
  }

  /**
   * 인증 가드가 요청마다 부르는 경량 조회. 모든 인증 요청이 DB를 한 번씩 더 치지 않도록
   * 짧게(AUTH_CACHE_TTL_MS) 메모리에 둔다.
   *
   * 트레이드오프: 다른 서버 인스턴스에서 정지/권한 변경을 하면 이 인스턴스에는 최대 TTL만큼 늦게 반영된다.
   * 같은 인스턴스에서 바꾸면(`updateById`) 바로 캐시가 무효화된다.
   */
  async getAuthSnapshot(id: string): Promise<AuthSnapshot | null> {
    const now = Date.now();
    const hit = this.authCache.get(id);
    if (hit && hit.expiresAt > now) return hit.snapshot;

    const user = await this.findById(id);
    if (!user) {
      this.authCache.delete(id);
      return null;
    }
    const snapshot: AuthSnapshot = {
      id: user.id,
      role: user.role,
      status: user.status,
      nickname: user.nickname,
    };
    this.authCache.delete(id); // 삽입 순서를 갱신해서 오래된 항목부터 밀려나게 한다
    this.authCache.set(id, { snapshot, expiresAt: now + AUTH_CACHE_TTL_MS });
    if (this.authCache.size > AUTH_CACHE_MAX) {
      this.authCache.delete(this.authCache.keys().next().value as string);
    }
    return snapshot;
  }

  /** 관리자 화면용 검색. 이메일/닉네임 부분 일치. */
  async search(q: string | undefined, page: number, limit: number) {
    const filter: QueryFilter<User> = {};
    if (q) {
      const rx = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      filter.$or = [{ email: rx }, { nickname: rx }];
    }
    const [items, total] = await Promise.all([
      this.users
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.users.countDocuments(filter).exec(),
    ]);
    return { items, total };
  }

  updateById(
    id: string,
    changes: Partial<Pick<User, 'role' | 'status' | 'bannedReason'>>,
    unsetReason = false,
  ): Promise<UserDocument | null> {
    this.authCache.delete(id);
    return this.users
      .findByIdAndUpdate(
        id,
        unsetReason ? { $set: changes, $unset: { bannedReason: '' } } : { $set: changes },
        { returnDocument: 'after' },
      )
      .exec();
  }

  count(): Promise<number> {
    return this.users.estimatedDocumentCount().exec();
  }
}
