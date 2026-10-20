import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { UsersService } from '../users/users.service.js';

export interface AuthUser {
  id: string;
  role: string;
  nickname: string;
}

export type AuthedRequest = Request & { user: AuthUser };

/**
 * 토큰을 검증하고, 사용자 상태를 매번 확인한다 (UsersService가 5초 캐시).
 * 그래서 정지(ban)나 권한 변경이 토큰 만료를 기다리지 않고 반영된다 — 같은 인스턴스에서는 즉시,
 * 다른 인스턴스에서는 최대 캐시 시간(5초) 안에. 역할(role)도 토큰이 아니라 DB 값을 쓴다.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly users: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const [type, token] = req.headers.authorization?.split(' ') ?? [];
    if (type !== 'Bearer' || !token) throw new UnauthorizedException();

    let sub: string;
    try {
      ({ sub } = await this.jwt.verifyAsync<{ sub: string }>(token));
    } catch {
      throw new UnauthorizedException();
    }

    const user = await this.users.getAuthSnapshot(sub);
    if (!user) throw new UnauthorizedException();
    if (user.status === 'banned') throw new ForbiddenException('정지된 계정입니다');

    req.user = { id: user.id, role: user.role, nickname: user.nickname };
    return true;
  }
}
