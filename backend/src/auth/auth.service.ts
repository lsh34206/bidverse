import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { UsersService } from '../users/users.service.js';
import type { UserDocument } from '../users/user.schema.js';
import type { LoginDto } from './dto/login.dto.js';
import type { RegisterDto } from './dto/register.dto.js';

export interface AuthResult {
  accessToken: string;
  user: { id: string; email: string; nickname: string; role: string };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResult> {
    const passwordHash = await bcrypt.hash(dto.password, 10);
    try {
      const user = await this.users.create({
        email: dto.email,
        nickname: dto.nickname,
        passwordHash,
      });
      return this.issue(user);
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        throw new ConflictException('이미 사용 중인 이메일 또는 닉네임입니다');
      }
      throw err;
    }
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const user = await this.users.findByEmail(dto.email);
    const ok = user && (await bcrypt.compare(dto.password, user.passwordHash));
    if (!user || !ok) {
      throw new UnauthorizedException('이메일 또는 비밀번호가 올바르지 않습니다');
    }
    if (user.status === 'banned') throw new ForbiddenException('정지된 계정입니다');
    return this.issue(user);
  }

  private async issue(user: UserDocument): Promise<AuthResult> {
    const id = user._id.toString();
    const accessToken = await this.jwt.signAsync({ sub: id, role: user.role });
    return {
      accessToken,
      user: { id, email: user.email, nickname: user.nickname, role: user.role },
    };
  }
}
