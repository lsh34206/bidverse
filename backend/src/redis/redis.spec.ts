import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import RedisMock from 'ioredis-mock';
import { io, type Socket } from 'socket.io-client';
import { BidsGateway, type BidEvent } from '../bids/bids.gateway.js';
import { RedisIoAdapter } from '../realtime/redis-io.adapter.js';
import { RedisThrottlerStorage } from './redis-throttler.storage.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 진짜 Redis 서버 없이 ioredis-mock으로 로직을 검증한다.
 * Lua 문법/pub-sub 동작은 mock 구현에 의존하므로, 실제 Redis 검증을 대체하지는 않는다.
 */
describe('RedisThrottlerStorage', () => {
  const make = () => {
    const redis = new RedisMock();
    return { redis, storage: new RedisThrottlerStorage(redis as never) };
  };

  it('윈도우 안에서 횟수를 세고 한도를 넘으면 차단 상태로 알린다', async () => {
    const { storage } = make();
    const hit = () => storage.increment('user:1', 10_000, 3, 0, 'default');

    const results = [await hit(), await hit(), await hit(), await hit()];
    expect(results.map((r) => r.totalHits)).toEqual([1, 2, 3, 4]);
    expect(results.map((r) => r.isBlocked)).toEqual([false, false, false, true]);
    expect(results[0].timeToExpire).toBeGreaterThan(0);
    expect(results[0].timeToExpire).toBeLessThanOrEqual(10);
  });

  it('키(사용자)별로, 이름(throttler)별로 따로 센다', async () => {
    const { storage } = make();
    await storage.increment('a', 10_000, 1, 0, 'default');
    expect((await storage.increment('a', 10_000, 1, 0, 'default')).isBlocked).toBe(true);
    expect((await storage.increment('b', 10_000, 1, 0, 'default')).isBlocked).toBe(false);
    expect((await storage.increment('a', 10_000, 1, 0, 'other')).isBlocked).toBe(false);
  });

  it('윈도우가 지나면 다시 센다', async () => {
    const { storage } = make();
    await storage.increment('k', 150, 1, 0, 'default');
    expect((await storage.increment('k', 150, 1, 0, 'default')).isBlocked).toBe(true);
    await sleep(250);
    const again = await storage.increment('k', 150, 1, 0, 'default');
    expect(again).toMatchObject({ totalHits: 1, isBlocked: false });
  });

  it('blockDuration이 있으면 한도를 넘긴 뒤 윈도우가 끝나도 차단이 유지된다', async () => {
    const { storage } = make();
    await storage.increment('k', 100, 1, 600, 'default');
    const over = await storage.increment('k', 100, 1, 600, 'default');
    expect(over.isBlocked).toBe(true);
    expect(over.timeToBlockExpire).toBeGreaterThan(0);
    await sleep(200); // 카운터 윈도우는 끝났지만
    expect((await storage.increment('k', 100, 1, 600, 'default')).isBlocked).toBe(true); // 차단은 남아 있다
  });

  it('여러 인스턴스(같은 Redis를 보는 별개 저장소 객체)가 한도를 함께 센다', async () => {
    const a = new RedisThrottlerStorage(new RedisMock() as never);
    const b = new RedisThrottlerStorage(new RedisMock() as never);
    await a.increment('shared', 10_000, 2, 0, 'default');
    await b.increment('shared', 10_000, 2, 0, 'default');
    expect((await a.increment('shared', 10_000, 2, 0, 'default')).isBlocked).toBe(true);
  });
});

describe('RedisIoAdapter (인스턴스 간 Socket.IO 전달)', () => {
  const apps: INestApplication[] = [];
  const clients: Socket[] = [];

  /** 어댑터를 붙인 게이트웨이 서버 한 대를 띄운다 = pm2 인스턴스 하나 */
  const instance = async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [BidsGateway, { provide: JwtService, useValue: new JwtService({ secret: 's' }) }],
    }).compile();
    const app = moduleRef.createNestApplication();
    const adapter = new RedisIoAdapter(app);
    const pub = new RedisMock();
    adapter.connect(pub as never, pub.duplicate() as never);
    app.useWebSocketAdapter(adapter);
    await app.listen(0);
    apps.push(app);
    const url = (await app.getUrl()).replace('[::1]', 'localhost');
    return { gateway: moduleRef.get(BidsGateway), url, jwt: moduleRef.get(JwtService) };
  };

  const connect = async (url: string, token?: string) => {
    const socket = io(url, { auth: { token }, transports: ['websocket'], forceNew: true });
    clients.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    return socket;
  };

  const waitEvent = <T>(socket: Socket, name: string, ms = 1500) =>
    new Promise<T | null>((resolve) => {
      const t = setTimeout(() => resolve(null), ms);
      socket.once(name, (p: T) => {
        clearTimeout(t);
        resolve(p);
      });
    });

  afterEach(async () => {
    clients.splice(0).forEach((c) => c.disconnect());
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  const bidEvent = (auctionId: string): BidEvent => ({
    auctionId,
    bid: { id: 'b1', amount: 1000, bidder: 'h***', createdAt: new Date() },
    currentPrice: 1000,
    bidCount: 1,
    minNextBid: 1500,
    highestBidderId: 'u1',
    endsAt: new Date(),
    extended: false,
  });

  it('다른 인스턴스에서 처리한 입찰이 이쪽 구경꾼에게도 전달된다', async () => {
    const [a, b] = [await instance(), await instance()];
    const auctionId = 'a'.repeat(24);

    const watcherOnA = await connect(a.url);
    await watcherOnA.emitWithAck('auction:join', { auctionId });

    const got = waitEvent<BidEvent>(watcherOnA, 'bid:new');
    b.gateway.emitBid(bidEvent(auctionId)); // 입찰은 인스턴스 B에서 처리됨
    expect((await got)?.currentPrice).toBe(1000);
  });

  it('개인 알림도 사용자가 붙어 있는 인스턴스로 전달되고, 다른 사용자에게는 가지 않는다', async () => {
    const [a, b] = [await instance(), await instance()];
    const me = await connect(a.url, await a.jwt.signAsync({ sub: 'user-1' }));
    const other = await connect(a.url, await a.jwt.signAsync({ sub: 'user-2' }));

    const got = waitEvent<{ type: string }>(me, 'notify');
    const notGot = waitEvent(other, 'notify', 400);
    b.gateway.notifyUser('user-1', { type: 'outbid', auctionId: 'x', title: '시계', amount: 1 });

    expect((await got)?.type).toBe('outbid');
    expect(await notGot).toBeNull();
  });

  it('다른 경매를 구독한 사람에게는 전달되지 않는다', async () => {
    const [a, b] = [await instance(), await instance()];
    const other = await connect(a.url);
    await other.emitWithAck('auction:join', { auctionId: 'b'.repeat(24) });
    const notGot = waitEvent(other, 'bid:new', 400);
    b.gateway.emitBid(bidEvent('a'.repeat(24)));
    expect(await notGot).toBeNull();
  });
});
