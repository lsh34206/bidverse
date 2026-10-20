import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { createRedis } from './redis/create-redis.js';
import { RedisIoAdapter } from './realtime/redis-io.adapter.js';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);

  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // pm2 reload/stop 때 SIGINT를 받아 DB 연결과 스케줄러를 정리하고 내려가게 한다.
  app.enableShutdownHooks();
  app.enableCors({ origin: config.get<string>('CORS_ORIGIN') ?? 'http://localhost:5173' });

  // nginx 뒤에서 실제 클라이언트 IP(X-Forwarded-For)를 쓰도록 한다. 속도 제한이 IP 기준이라 필요하다.
  // 값은 앞단 프록시 개수 (nginx 하나면 1). 프록시 없이 직접 노출할 때는 설정하지 않는다.
  const trustProxy = config.get<string>('TRUST_PROXY');
  if (trustProxy) app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);

  // 여러 인스턴스를 띄울 때는 Redis로 Socket.IO 이벤트를 서로 전달한다.
  const redisUrl = config.get<string>('REDIS_URL');
  if (redisUrl) {
    const adapter = new RedisIoAdapter(app);
    const pub = createRedis(redisUrl, 'socket-pub');
    adapter.connect(pub, pub.duplicate());
    app.useWebSocketAdapter(adapter);
    logger.log('Socket.IO: Redis 어댑터 사용 (다중 인스턴스 지원)');
  } else {
    logger.log('Socket.IO: 단일 인스턴스 모드 (REDIS_URL 없음)');
  }

  const port = config.get<string>('PORT') ?? 3000;
  await app.listen(port);
  logger.log(`listening on :${port}`);
}
await bootstrap();
