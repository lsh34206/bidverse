import { Injectable, OnModuleDestroy } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';

export interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/**
 * 고정 윈도우 카운터. 증가와 만료 설정을 Lua 한 번으로 처리해서 인스턴스가 여러 대여도 정확하다.
 *  KEYS[1] = 히트 카운터, KEYS[2] = 차단 표시
 *  ARGV    = ttl(ms), limit, blockDuration(ms)
 *  반환    = { hits, 남은 윈도우(ms), 차단 여부(0/1), 남은 차단(ms) }
 */
const INCREMENT_LUA = `
local blockTtl = redis.call('PTTL', KEYS[2])
if blockTtl > 0 then
  local hits = tonumber(redis.call('GET', KEYS[1]) or '0')
  return { hits, redis.call('PTTL', KEYS[1]), 1, blockTtl }
end
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
local limit = tonumber(ARGV[2])
local blockMs = tonumber(ARGV[3])
if hits > limit then
  if blockMs > 0 then
    redis.call('SET', KEYS[2], '1', 'PX', blockMs)
    return { hits, ttl, 1, blockMs }
  end
  return { hits, ttl, 1, ttl }
end
return { hits, ttl, 0, 0 }
`;

const toSeconds = (ms: number) => Math.max(0, Math.ceil(ms / 1000));

/** 속도 제한 카운터를 Redis에 둬서 여러 서버 인스턴스가 한도를 함께 센다. */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage, OnModuleDestroy {
  constructor(private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const base = `throttle:${throttlerName}:${key}`;
    const [hits, windowMs, blocked, blockMs] = (await this.redis.eval(
      INCREMENT_LUA,
      2,
      base,
      `${base}:block`,
      ttl,
      limit,
      blockDuration,
    )) as [number, number, number, number];

    return {
      totalHits: Number(hits),
      timeToExpire: toSeconds(Number(windowMs)),
      isBlocked: Number(blocked) === 1,
      timeToBlockExpire: toSeconds(Number(blockMs)),
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}
