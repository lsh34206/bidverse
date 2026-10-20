import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { AdminGuard } from './admin.guard.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';

const ctx = (req: Record<string, unknown>) =>
  ({ switchToHttp: () => ({ getRequest: () => req }) }) as unknown as ExecutionContext;

describe('JwtAuthGuard', () => {
  const jwt = { verifyAsync: vi.fn() };
  const users = { getAuthSnapshot: vi.fn() };
  const guard = new JwtAuthGuard(jwt as never, users as never);
  const withToken = () => ({ headers: { authorization: 'Bearer tok' } }) as Record<string, any>;

  beforeEach(() => vi.clearAllMocks());

  it('토큰이 없거나 형식이 틀리면 401', async () => {
    await expect(guard.canActivate(ctx({ headers: {} }))).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      guard.canActivate(ctx({ headers: { authorization: 'Basic abc' } })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('검증에 실패한 토큰은 401', async () => {
    jwt.verifyAsync.mockRejectedValue(new Error('expired'));
    await expect(guard.canActivate(ctx(withToken()))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('토큰은 유효한데 사용자가 사라졌으면 401', async () => {
    jwt.verifyAsync.mockResolvedValue({ sub: 'u1' });
    users.getAuthSnapshot.mockResolvedValue(null);
    await expect(guard.canActivate(ctx(withToken()))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('정지된 계정은 유효한 토큰이 있어도 403', async () => {
    jwt.verifyAsync.mockResolvedValue({ sub: 'u1' });
    users.getAuthSnapshot.mockResolvedValue({ id: 'u1', role: 'buyer', status: 'banned' });
    await expect(guard.canActivate(ctx(withToken()))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('역할은 토큰이 아니라 DB 값을 쓴다 (권한 변경 즉시 반영)', async () => {
    jwt.verifyAsync.mockResolvedValue({ sub: 'u1', role: 'admin' }); // 토큰엔 옛 역할이 남아 있어도
    users.getAuthSnapshot.mockResolvedValue({ id: 'u1', role: 'buyer', status: 'active', nickname: 'nick' });
    const req = withToken();
    expect(await guard.canActivate(ctx(req))).toBe(true);
    expect(req.user).toEqual({ id: 'u1', role: 'buyer', nickname: 'nick' });
  });
});

describe('AdminGuard', () => {
  const guard = new AdminGuard();

  it('관리자만 통과한다', () => {
    expect(guard.canActivate(ctx({ user: { id: 'a', role: 'admin' } }))).toBe(true);
    expect(() => guard.canActivate(ctx({ user: { id: 'u', role: 'buyer' } }))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctx({}))).toThrow(ForbiddenException);
  });
});
