import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthedRequest } from './jwt-auth.guard.js';

/** JwtAuthGuard 뒤에 붙여서 쓴다: `@UseGuards(JwtAuthGuard, AdminGuard)` */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (req.user?.role !== 'admin') throw new ForbiddenException('관리자만 접근할 수 있습니다');
    return true;
  }
}
