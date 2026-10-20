import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

const logger = new Logger('Redis');

/** REDIS_URL로 클라이언트를 만든다. 연결 오류는 로그만 남기고 ioredis의 자동 재연결에 맡긴다. */
export function createRedis(url: string, name: string): Redis {
  const client = new Redis(url, {
    connectionName: `bidverse-${name}`,
    // 명령이 무한정 쌓여 요청이 매달리는 것보다, 끊겼을 때 빨리 실패하는 편이 낫다.
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
  });
  client.on('error', (err) => logger.error(`${name}: ${err.message}`));
  client.on('ready', () => logger.log(`${name}: 연결됨`));
  return client;
}
