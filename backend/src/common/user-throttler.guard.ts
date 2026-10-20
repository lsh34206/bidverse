import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * 로그인한 사용자는 사용자 id 기준으로 횟수를 센다 (같은 공유기 뒤의 사용자끼리 서로 막지 않도록).
 * JwtAuthGuard 뒤에 붙여서 써야 req.user가 채워져 있다. 없으면 IP로 센다.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, any>): Promise<string> {
    return req.user?.id ?? req.ip;
  }
}
