import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import bcrypt from 'bcryptjs';
import { UsersService } from '../users/users.service.js';
import { AuthService } from './auth.service.js';

describe('AuthService', () => {
  let service: AuthService;
  const users = { create: vi.fn(), findByEmail: vi.fn() };
  const jwt = { signAsync: vi.fn().mockResolvedValue('token') };

  const userDoc = async (password: string) => ({
    _id: { toString: () => 'u1' },
    email: 'a@b.com',
    nickname: 'nick',
    role: 'buyer',
    passwordHash: await bcrypt.hash(password, 4),
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: users },
        { provide: JwtService, useValue: jwt },
      ],
    }).compile();
    service = module.get(AuthService);
  });

  it('가입 시 비밀번호를 해시해 저장하고 토큰을 발급한다', async () => {
    users.create.mockImplementation(async (d) => ({ ...(await userDoc('x')), ...d }));
    const res = await service.register({ email: 'a@b.com', password: 'password1', nickname: 'nick' });
    expect(res.accessToken).toBe('token');
    const saved = users.create.mock.calls[0][0];
    expect(saved.passwordHash).not.toBe('password1');
    expect(await bcrypt.compare('password1', saved.passwordHash)).toBe(true);
  });

  it('중복 이메일/닉네임이면 409', async () => {
    users.create.mockRejectedValue({ code: 11000 });
    await expect(
      service.register({ email: 'a@b.com', password: 'password1', nickname: 'nick' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('올바른 비밀번호로 로그인한다', async () => {
    users.findByEmail.mockResolvedValue(await userDoc('password1'));
    const res = await service.login({ email: 'a@b.com', password: 'password1' });
    expect(res.user.id).toBe('u1');
  });

  it('틀린 비밀번호/없는 사용자는 401', async () => {
    users.findByEmail.mockResolvedValue(await userDoc('password1'));
    await expect(service.login({ email: 'a@b.com', password: 'wrong' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    users.findByEmail.mockResolvedValue(null);
    await expect(service.login({ email: 'n@b.com', password: 'x' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
