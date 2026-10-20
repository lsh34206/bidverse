import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { io, type Socket } from 'socket.io-client';
import { BidsGateway, type BidEvent } from './bids.gateway.js';

const auctionId = new Types.ObjectId().toString();
const otherAuction = new Types.ObjectId().toString();

const event = (id = auctionId): BidEvent => ({
  auctionId: id,
  bid: { id: 'b1', amount: 2000, bidder: 'h***', createdAt: new Date() },
  currentPrice: 2000,
  bidCount: 1,
  minNextBid: 2500,
  highestBidderId: 'u1',
  endsAt: new Date(),
});

const collectEvents = <T,>(socket: Socket, name: string): T[] => {
  const events: T[] = [];
  socket.on(name, (e: T) => events.push(e));
  return events;
};
const waitFor = async (cond: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('조건이 시간 안에 충족되지 않음');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('BidsGateway (실제 Socket.IO 연결)', () => {
  let app: INestApplication;
  let gateway: BidsGateway;
  let jwt: JwtService;
  let url: string;
  const clients: Socket[] = [];

  const connect = async (token?: string) => {
    const client = io(url, { auth: { token }, transports: ['websocket'], forceNew: true });
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('connect_error', reject);
    });
    return client;
  };
  const join = (client: Socket, id: string) =>
    client.emitWithAck('auction:join', { auctionId: id }) as Promise<{
      ok: boolean;
      serverTime?: number;
    }>;
  const nextEvent = <T>(client: Socket, name: string, ms = 1000) =>
    new Promise<T | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), ms);
      client.once(name, (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      providers: [BidsGateway, { provide: JwtService, useValue: new JwtService({ secret: 's' }) }],
    }).compile();
    app = module.createNestApplication();
    await app.listen(0);
    gateway = module.get(BidsGateway);
    jwt = module.get(JwtService);
    url = await app.getUrl();
    url = url.replace('[::1]', 'localhost');
  });

  afterEach(() => {
    clients.splice(0).forEach((c) => c.disconnect());
  });

  afterAll(async () => {
    await app.close();
  });

  it('join한 클라이언트만 해당 경매의 bid:new를 받는다', async () => {
    const watcher = await connect();
    const bystander = await connect();
    const elsewhere = await connect();
    expect((await join(watcher, auctionId)).ok).toBe(true);
    expect((await join(elsewhere, otherAuction)).ok).toBe(true);

    const got = nextEvent<BidEvent>(watcher, 'bid:new');
    const notGotBystander = nextEvent(bystander, 'bid:new', 300);
    const notGotElsewhere = nextEvent(elsewhere, 'bid:new', 300);
    gateway.emitBid(event());

    expect((await got)?.currentPrice).toBe(2000);
    expect(await notGotBystander).toBeNull();
    expect(await notGotElsewhere).toBeNull();
  });

  it('join 응답에 서버 시각이 들어 있다', async () => {
    const client = await connect();
    const ack = await join(client, auctionId);
    expect(Math.abs((ack.serverTime ?? 0) - Date.now())).toBeLessThan(5000);
  });

  it('잘못된 경매 ID는 거절한다', async () => {
    const client = await connect();
    expect((await join(client, 'not-an-id')).ok).toBe(false);
  });

  it('leave 후에는 이벤트를 받지 않는다', async () => {
    const client = await connect();
    await join(client, auctionId);
    await client.emitWithAck('auction:leave', { auctionId });
    const got = nextEvent(client, 'bid:new', 300);
    gateway.emitBid(event());
    expect(await got).toBeNull();
  });

  it('토큰이 유효한 사용자에게만 개인 알림이 간다', async () => {
    const userToken = await jwt.signAsync({ sub: 'user-1' });
    const user = await connect(userToken);
    const guest = await connect();
    const badToken = await connect('garbage');
    const otherUser = await connect(await jwt.signAsync({ sub: 'user-2' }));

    const got = nextEvent<{ type: string }>(user, 'notify');
    const guestGot = nextEvent(guest, 'notify', 300);
    const badGot = nextEvent(badToken, 'notify', 300);
    const otherGot = nextEvent(otherUser, 'notify', 300);
    gateway.notifyUser('user-1', { type: 'outbid', auctionId, title: '시계', amount: 3000 });

    expect((await got)?.type).toBe('outbid');
    expect(await guestGot).toBeNull();
    expect(await badGot).toBeNull();
    expect(await otherGot).toBeNull();
  });

  it('같은 경매방의 접속자 수를 집계해 방 전체에 알린다 (입장/퇴장 모두)', async () => {
    const auction = new Types.ObjectId().toString();
    const a = await connect();
    const viewersA = collectEvents<{ auctionId: string; count: number }>(a, 'auction:viewers');
    await join(a, auction);
    await waitFor(() => viewersA.some((v) => v.count === 1));

    const b = await connect();
    await join(b, auction);
    await waitFor(() => viewersA.some((v) => v.count === 2));

    b.disconnect(); // 탭을 닫으면 자동으로 줄어든다
    await waitFor(() => viewersA.at(-1)?.count === 1);
    expect(viewersA.every((v) => v.auctionId === auction)).toBe(true);
  });

  it('입장 응답에는 직전 집계값이 들어 있고, 다른 경매방에는 알리지 않는다', async () => {
    const auction = new Types.ObjectId().toString();
    const other = new Types.ObjectId().toString();
    const first = await connect();
    await join(first, auction);
    const bystander = await connect();
    await join(bystander, other);
    const bystanderViewers = collectEvents<{ auctionId: string }>(bystander, 'auction:viewers');
    await waitFor(() => bystanderViewers.length > 0);
    expect(bystanderViewers.every((v) => v.auctionId === other)).toBe(true);

    const second = await connect();
    const ack = await join(second, auction);
    expect(ack.viewers).toBe(1); // 두 번째 사람이 들어올 때 직전 집계는 첫 사람 한 명
  });

  it('채팅 이벤트는 해당 경매방에만 전달된다', async () => {
    const auction = new Types.ObjectId().toString();
    const inRoom = await connect();
    const outside = await connect();
    await join(inRoom, auction);
    const got = nextEvent<{ text: string }>(inRoom, 'chat:new');
    const notGot = nextEvent(outside, 'chat:new', 300);
    gateway.emitChat({
      id: 'm1',
      auctionId: auction,
      userId: 'u1',
      nickname: 'hong',
      text: '안녕하세요',
      isSeller: false,
      isAdmin: false,
      createdAt: new Date(),
    });
    expect((await got)?.text).toBe('안녕하세요');
    expect(await notGot).toBeNull();

    const deleted = nextEvent<{ messageId: string }>(inRoom, 'chat:deleted');
    gateway.emitChatDeleted({ auctionId: auction, messageId: 'm1' });
    expect((await deleted)?.messageId).toBe('m1');
  });

});
