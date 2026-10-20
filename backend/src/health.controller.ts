import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';

/** nginx/모니터링이 인스턴스 상태를 확인하는 용도. DB 연결이 살아 있어야 200이다. */
@Controller('health')
export class HealthController {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  @Get()
  async check() {
    // readyState 1 = connected
    if (this.connection.readyState !== 1) throw new ServiceUnavailableException('db not connected');
    try {
      await this.connection.db!.admin().ping();
    } catch {
      throw new ServiceUnavailableException('db ping failed');
    }
    return { status: 'ok', uptime: Math.round(process.uptime()) };
  }
}
