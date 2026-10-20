import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Redis } from 'ioredis';
import type { ServerOptions } from 'socket.io';

/**
 * 서버 인스턴스가 여러 대일 때 Socket.IO 이벤트를 Redis pub/sub으로 전달하는 어댑터.
 * 인스턴스 A에서 입찰이 처리돼도, 인스턴스 B에 붙은 구경꾼에게 bid:new / 개인 알림이 간다.
 *
 * 연결 방식은 websocket 전용이어야 한다. 기본값인 HTTP long-polling은 요청마다 다른
 * 인스턴스로 갈 수 있어서 sticky session 없이는 끊긴다. (프론트가 transports: ['websocket']을 쓴다)
 */
export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor!: ReturnType<typeof createAdapter>;

  constructor(app: INestApplicationContext) {
    super(app);
  }

  /** pub/sub은 각각 전용 연결이 필요하다 (구독 중인 연결은 다른 명령을 못 쓴다). */
  connect(pubClient: Redis, subClient: Redis): void {
    this.adapterConstructor = createAdapter(pubClient, subClient);
  }

  override createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, options);
    server.adapter(this.adapterConstructor);
    return server;
  }
}
