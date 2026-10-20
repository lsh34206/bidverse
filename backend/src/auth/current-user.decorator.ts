import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthedRequest, AuthUser } from './jwt-auth.guard.js';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser =>
    ctx.switchToHttp().getRequest<AuthedRequest>().user,
);
