import { SettlementService } from '../src/settlement/settlement.service.js';
import { EndingSoonService } from '../src/watchlist/ending-soon.service.js';
import { collect, inFuture, joinAuction, sleep, startApp, type TestApp } from './helpers.js';

/**
 * 실제 MongoDB에 임시 DB를 만들어 전체 흐름을 검증한다. (MONGODB_URI 필요)
 *   npm run test:e2e
 */
describe('BidVerse E2E (실제 MongoDB)', () => {
  let t: TestApp;
  const M = () => t.connection.models;

  const createAuction = async (token: string, over: Record<string, unknown> = {}) => {
    const res = await t.request('POST', '/auctions', {
      token,
      body: { title: '테스트 경매', startPrice: 1000, minIncrement: 500, endsAt: inFuture(2 * 3600_000), ...over },
    });
    if (res.status !== 201) throw new Error(`create auction failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as { id: string; endsAt: string };
  };
  const bid = (token: string, auctionId: string, amount: number) =>
    t.request('POST', `/auctions/${auctionId}/bids`, { token, body: { amount } });
  const expire = (auctionId: string) =>
    M().Auction.updateOne({ _id: auctionId }, { $set: { endsAt: new Date(Date.now() - 1000) } });

  beforeAll(async () => {
    t = await startApp();
  }, 60_000);

  afterAll(async () => {
    await t?.close();
  }, 60_000);

  describe('인증', () => {
    it('가입 → 로그인 → 내 정보, 중복/검증/오답 처리', async () => {
      const email = `auth-${Date.now()}@example.com`;
      const body = { email, password: 'password123', nickname: 'authuser' };

      const reg = await t.request('POST', '/auth/register', { body });
      expect(reg.status).toBe(201);
      expect(reg.body.accessToken).toBeTruthy();
      expect(reg.body.user).toMatchObject({ email, nickname: 'authuser', role: 'buyer' });

      expect((await t.request('POST', '/auth/register', { body })).status).toBe(409);
      expect(
        (await t.request('POST', '/auth/register', { body: { ...body, email: 'bad', password: '1' } })).status,
      ).toBe(400);

      const login = await t.request('POST', '/auth/login', { body: { email, password: 'password123' } });
      expect(login.status).toBe(201);
      expect((await t.request('POST', '/auth/login', { body: { email, password: 'wrongpass' } })).status).toBe(401);

      const me = await t.request('GET', '/auth/me', { token: login.body.accessToken });
      expect(me.body).toMatchObject({ email, nickname: 'authuser' });
      expect((await t.request('GET', '/auth/me')).status).toBe(401);
    });

    it('비밀번호는 해시로만 저장된다', async () => {
      const u = await t.register('hashcheck');
      const doc = await M().User.findById(u.id).lean<any>();
      expect(doc.passwordHash).toMatch(/^\$2[aby]\$/);
      expect(JSON.stringify(doc)).not.toContain('password123');
    });
  });

  describe('경매 CRUD', () => {
    it('등록·조회·목록 필터·수정·삭제와 권한', async () => {
      const seller = await t.register('seller1');
      const other = await t.register('other1');

      const a = await createAuction(seller.token, { title: '희귀 시계', category: '수집품' });
      const detail = await t.request('GET', `/auctions/${a.id}`);
      expect(detail.body).toMatchObject({
        title: '희귀 시계',
        status: 'live',
        currentPrice: 1000,
        minNextBid: 1000,
        bidCount: 0,
        suspended: false,
        seller: { id: seller.id, nickname: 'seller1' },
      });

      const list = await t.request('GET', '/auctions?q=희귀&category=수집품&status=live');
      expect(list.body.items.map((x: any) => x.id)).toContain(a.id);
      expect((await t.request('GET', '/auctions?status=ended&q=희귀')).body.items).toHaveLength(0);

      expect((await t.request('PATCH', `/auctions/${a.id}`, { token: other.token, body: { title: 'x' } })).status).toBe(403);
      const upd = await t.request('PATCH', `/auctions/${a.id}`, { token: seller.token, body: { startPrice: 2000 } });
      expect(upd.body).toMatchObject({ startPrice: 2000, currentPrice: 2000 });

      expect((await t.request('DELETE', `/auctions/${a.id}`, { token: other.token })).status).toBe(403);
      expect((await t.request('DELETE', `/auctions/${a.id}`, { token: seller.token })).status).toBe(204);
      expect((await t.request('GET', `/auctions/${a.id}`)).status).toBe(404);
    });

    it('입력 검증: 과거 종료 시각, 30일 초과, 즉시구매가 ≤ 시작가', async () => {
      const s = await t.register('validator');
      const post = (over: object) =>
        t.request('POST', '/auctions', {
          token: s.token,
          body: { title: 'v', startPrice: 1000, endsAt: inFuture(3600_000), ...over },
        });
      expect((await post({ endsAt: inFuture(-1000) })).status).toBe(400);
      expect((await post({ endsAt: inFuture(31 * 24 * 3600_000) })).status).toBe(400);
      expect((await post({ buyNowPrice: 1000 })).status).toBe(400);
      expect((await t.request('POST', '/auctions', { body: {} })).status).toBe(401);
    });
  });

  describe('입찰 + 실시간', () => {
    it('입찰 규칙, 이력 마스킹, bid:new 브로드캐스트, 상회 입찰 알림이 저장된다', async () => {
      const seller = await t.register('seller2');
      const a = await t.register('alice');
      const b = await t.register('bobby');
      const auction = await createAuction(seller.token);

      const watcher = await t.connectSocket();
      const aliceSocket = await t.connectSocket(a.token);
      await joinAuction(watcher, auction.id);
      const bidEvents = collect(watcher, 'bid:new');
      const notifyEvents = collect(aliceSocket, 'notify');

      expect((await bid(a.token, auction.id, 999)).status).toBe(409); // 시작가 미만
      expect((await bid(seller.token, auction.id, 1000)).status).toBe(403); // 판매자
      expect((await bid(undefined as never, auction.id, 1000)).status).toBe(401);

      const first = await bid(a.token, auction.id, 1000);
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ currentPrice: 1000, bidCount: 1, minNextBid: 1500, extended: false });
      expect(first.body.bid.bidder).toBe('a***');

      expect((await bid(a.token, auction.id, 5000)).status).toBe(409); // 이미 최고가
      expect((await bid(b.token, auction.id, 1200)).status).toBe(409); // 최소 단위 미달
      expect((await bid(b.token, auction.id, 1500)).status).toBe(201);

      const events = await bidEvents.waitFor(2);
      expect(events.map((e) => e.currentPrice)).toEqual([1000, 1500]);

      const notes = await notifyEvents.waitFor(1);
      expect(notes[0]).toMatchObject({ type: 'outbid', auctionId: auction.id, amount: 1500 });
      expect(notes[0].id).toBeTruthy(); // 저장된 알림

      const detail = await t.request('GET', `/auctions/${auction.id}`);
      expect(detail.body).toMatchObject({ currentPrice: 1500, bidCount: 2, highestBidderId: b.id, minNextBid: 2000 });

      const history = await t.request('GET', `/auctions/${auction.id}/bids`);
      expect(history.body.map((x: any) => x.amount)).toEqual([1500, 1000]);
      expect(history.body[0].bidder).toBe('b***');

      // 알림 센터
      const inbox = await t.request('GET', '/me/notifications', { token: a.token });
      expect(inbox.body).toMatchObject({ total: 1, unreadCount: 1 });
      expect(inbox.body.items[0]).toMatchObject({ type: 'outbid', read: false, amount: 1500 });
      expect((await t.request('GET', '/me/notifications/unread-count', { token: b.token })).body.unreadCount).toBe(0);
      expect((await t.request('POST', '/me/notifications/read', { token: a.token, body: {} })).body.modified).toBe(1);
      expect((await t.request('GET', '/me/notifications/unread-count', { token: a.token })).body.unreadCount).toBe(0);
    });

    it('스나이핑 방지: 마감 5분 미만이면 실제 MongoDB 파이프라인으로 5분 연장, 상한이 지켜진다', async () => {
      const seller = await t.register('seller3');
      const u = await t.register('sniper');
      const v = await t.register('sniper2');
      const auction = await createAuction(seller.token, { endsAt: inFuture(60_000) });

      const before = Date.now();
      const r1 = await bid(u.token, auction.id, 1000);
      expect(r1.body.extended).toBe(true);
      const newEnd = new Date(r1.body.endsAt).getTime();
      expect(newEnd).toBeGreaterThan(before + 4.9 * 60_000);
      expect(newEnd).toBeLessThan(before + 5.2 * 60_000);

      const stored = await M().Auction.findById(auction.id).lean<any>();
      expect(stored.extensionCount).toBe(1);
      expect(new Date(stored.endsAt).getTime()).toBe(newEnd);

      // 이제 5분 가까이 남았으니(>=5분 - 몇 ms) 마감 구간을 다시 만든다
      await M().Auction.updateOne({ _id: auction.id }, { $set: { endsAt: new Date(Date.now() + 30_000), extensionCount: 20 } });
      const r2 = await bid(v.token, auction.id, 1500);
      expect(r2.status).toBe(201);
      expect(r2.body.extended).toBe(false); // 상한 도달
      const capped = await M().Auction.findById(auction.id).lean<any>();
      expect(capped.extensionCount).toBe(20);
      expect(new Date(capped.endsAt).getTime()).toBeLessThan(Date.now() + 31_000);

      // 마감이 넉넉한 경매는 그대로
      const calm = await createAuction(seller.token, { endsAt: inFuture(3600_000) });
      const r3 = await bid(u.token, calm.id, 1000);
      expect(r3.body.extended).toBe(false);
      expect(new Date(r3.body.endsAt).toISOString()).toBe(new Date(calm.endsAt).toISOString());
    });

    it('즉시구매: 그 자리에서 종료·정산되어 주문이 생기고 낙찰/판매 알림이 간다', async () => {
      const seller = await t.register('seller4');
      const prev = await t.register('prevbidder');
      const buyer = await t.register('buyer4');
      const auction = await createAuction(seller.token, { buyNowPrice: 10000 });

      const buyerSocket = await t.connectSocket(buyer.token);
      const sellerSocket = await t.connectSocket(seller.token);
      const prevSocket = await t.connectSocket(prev.token);
      const watcher = await t.connectSocket();
      await joinAuction(watcher, auction.id);
      const won = collect(buyerSocket, 'notify');
      const sold = collect(sellerSocket, 'notify');
      const outbid = collect(prevSocket, 'notify');
      const ended = collect(watcher, 'auction:ended');

      await bid(prev.token, auction.id, 3000);
      expect((await t.request('POST', `/auctions/${auction.id}/buy-now`, { token: seller.token })).status).toBe(403);

      const res = await t.request('POST', `/auctions/${auction.id}/buy-now`, { token: buyer.token });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ currentPrice: 10000, bidCount: 2, highestBidderId: buyer.id });

      const detail = await t.request('GET', `/auctions/${auction.id}`);
      expect(detail.body).toMatchObject({ status: 'ended', result: 'sold', currentPrice: 10000 });

      expect((await won.waitFor(1))[0]).toMatchObject({ type: 'won', amount: 10000 });
      expect((await sold.waitFor(1))[0]).toMatchObject({ type: 'sold', amount: 10000 });
      expect((await outbid.waitFor(1))[0]).toMatchObject({ type: 'outbid', amount: 10000 });
      expect((await ended.waitFor(1))[0]).toMatchObject({ result: 'sold', finalPrice: 10000 });

      const orders = await t.request('GET', '/me/orders', { token: buyer.token });
      expect(orders.body).toHaveLength(1);
      expect(orders.body[0]).toMatchObject({ finalPrice: 10000, status: 'pending', role: 'buyer' });

      // 이미 끝난 경매는 다시 살 수도 입찰할 수도 없다
      expect((await t.request('POST', `/auctions/${auction.id}/buy-now`, { token: prev.token })).status).toBe(409);
      expect((await bid(prev.token, auction.id, 20000)).status).toBe(409);
    });
  });

  describe('종료 정산 + 주문', () => {
    it('종료된 경매를 정산하면 주문이 하나만 생기고, 다시 돌려도 중복되지 않는다', async () => {
      const seller = await t.register('seller5');
      const winner = await t.register('winner5');
      const auction = await createAuction(seller.token);
      await bid(winner.token, auction.id, 1000);
      await bid((await t.register('loser5')).token, auction.id, 1500);
      await bid(winner.token, auction.id, 2000);

      const winnerSocket = await t.connectSocket(winner.token);
      const sellerSocket = await t.connectSocket(seller.token);
      const watcher = await t.connectSocket();
      await joinAuction(watcher, auction.id);
      const won = collect(winnerSocket, 'notify');
      const sold = collect(sellerSocket, 'notify');
      const ended = collect(watcher, 'auction:ended');

      await expire(auction.id);
      const settlement = t.get<SettlementService>(SettlementService);
      expect(await settlement.sweep()).toBeGreaterThanOrEqual(1);
      expect(await settlement.sweep()).toBe(0); // 이미 정산됨

      const detail = await t.request('GET', `/auctions/${auction.id}`);
      expect(detail.body).toMatchObject({ status: 'ended', result: 'sold', currentPrice: 2000 });

      expect(await M().Order.countDocuments({ auctionId: auction.id })).toBe(1);
      expect((await won.waitFor(1))[0]).toMatchObject({ type: 'won', amount: 2000 });
      expect((await sold.waitFor(1))[0]).toMatchObject({ type: 'sold', amount: 2000 });
      expect((await ended.waitFor(1))[0].winner).toBe('w***');
      await sleep(150);
      expect(won.events).toHaveLength(1); // 알림 중복 없음

      // 같은 경매를 동시에 여러 번 정산해도 주문/알림은 한 번
      const dup = await createAuction(seller.token);
      await bid(winner.token, dup.id, 1000);
      await expire(dup.id);
      const results = await Promise.all([1, 2, 3, 4, 5].map(() => settlement.settle(dup.id)));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await M().Order.countDocuments({ auctionId: dup.id })).toBe(1);
      expect(await M().Notification.countDocuments({ auctionId: dup.id, type: 'won' })).toBe(1);
    });

    it('입찰 없이 끝나면 유찰, 주문 없음, 판매자에게만 알림', async () => {
      const seller = await t.register('seller6');
      const auction = await createAuction(seller.token);
      await expire(auction.id);
      await t.get<SettlementService>(SettlementService).sweep();

      expect((await t.request('GET', `/auctions/${auction.id}`)).body).toMatchObject({ status: 'ended', result: 'unsold' });
      expect(await M().Order.countDocuments({ auctionId: auction.id })).toBe(0);
      const inbox = await t.request('GET', '/me/notifications', { token: seller.token });
      expect(inbox.body.items.map((n: any) => n.type)).toContain('unsold');
    });

    it('유찰된 경매의 종료 시각을 다시 잡으면 재등록되어 다시 진행된다', async () => {
      const seller = await t.register('seller7');
      const buyer = await t.register('buyer7');
      const auction = await createAuction(seller.token);
      await expire(auction.id);
      await t.get<SettlementService>(SettlementService).sweep();

      const relist = await t.request('PATCH', `/auctions/${auction.id}`, {
        token: seller.token,
        body: { endsAt: inFuture(3600_000) },
      });
      expect(relist.status).toBe(200);
      expect(relist.body).toMatchObject({ status: 'live', result: null });
      expect((await bid(buyer.token, auction.id, 1000)).status).toBe(201);
    });

    it('주문 진행(모의 결제 모드): 결제(구매자) → 발송(판매자) → 수령 확인(구매자), 역할/순서 위반은 거절', async () => {
      const seller = await t.register('seller8');
      const buyer = await t.register('buyer8');
      const stranger = await t.register('stranger8');
      const auction = await createAuction(seller.token);
      await bid(buyer.token, auction.id, 1000);
      await expire(auction.id);
      await t.get<SettlementService>(SettlementService).sweep();
      const order = (await t.request('GET', '/me/orders', { token: buyer.token })).body[0];

      const act = (who: { token: string }, step: string) =>
        t.request('POST', `/orders/${order.id}/${step}`, { token: who.token });

      const prepare = (who: { token: string }) => t.request('POST', `/orders/${order.id}/payment`, { token: who.token });
      expect((await prepare(stranger)).status).toBe(404); // 당사자가 아니면 존재도 숨김
      expect((await prepare(seller)).status).toBe(404); // 판매자는 결제할 수 없다
      expect((await act(seller, 'ship')).status).toBe(409); // 결제 전 발송 불가

      // 키 없는 개발 환경: 모의 토스가 승인한다 (운영에서는 이 모드가 열리지 않는다)
      const prep = (await prepare(buyer)).body;
      expect(prep.mode).toBe('mock');
      const paid = await t.request('POST', '/payments/confirm', {
        token: buyer.token,
        body: { paymentKey: 'mock_e2e_key', orderId: prep.orderId, amount: prep.amount },
      });
      expect(paid.body).toMatchObject({ status: 'paid', order: { status: 'paid' } });
      expect((await prepare(buyer)).status).toBe(409); // 이중 결제 불가
      expect((await act(buyer, 'ship')).status).toBe(403);
      expect((await act(seller, 'ship')).body.status).toBe('shipped');
      const done = await act(buyer, 'confirm');
      expect(done.body).toMatchObject({ status: 'done', role: 'buyer' });
      expect((await t.request('GET', '/me/orders', { token: seller.token })).body[0].role).toBe('seller');
    });
  });

  describe('관심 목록 + 종료 임박', () => {
    it('담기/빼기/목록, 마감 1시간 전 알림은 관심 등록자에게 한 번만', async () => {
      const seller = await t.register('seller9');
      const fan = await t.register('fan9');
      const bystander = await t.register('bystander9');
      const soon = await createAuction(seller.token, { endsAt: inFuture(30 * 60_000) });
      const later = await createAuction(seller.token, { endsAt: inFuture(5 * 3600_000) });

      expect((await t.request('POST', `/watchlist/${soon.id}`, { token: fan.token })).body).toEqual({ watching: true });
      expect((await t.request('POST', `/watchlist/${soon.id}`, { token: fan.token })).status).toBe(200); // 멱등
      await t.request('POST', `/watchlist/${later.id}`, { token: fan.token });
      expect((await t.request('POST', `/watchlist/${'a'.repeat(24)}`, { token: fan.token })).status).toBe(404);
      expect(await M().Watch.countDocuments({ userId: fan.id })).toBe(2);

      const ids = await t.request('GET', '/me/watchlist/ids', { token: fan.token });
      expect(ids.body).toEqual([later.id, soon.id]);
      const list = await t.request('GET', '/me/watchlist', { token: fan.token });
      expect(list.body.map((a: any) => a.id)).toEqual([later.id, soon.id]);

      const sweeper = t.get<EndingSoonService>(EndingSoonService);
      await sweeper.sweep();
      await sweeper.sweep(); // 두 번째는 보내지 않는다
      const fanInbox = await t.request('GET', '/me/notifications', { token: fan.token });
      const endings = fanInbox.body.items.filter((n: any) => n.type === 'ending');
      expect(endings).toHaveLength(1);
      expect(endings[0].auctionId).toBe(soon.id);
      expect((await t.request('GET', '/me/notifications', { token: bystander.token })).body.total).toBe(0);

      expect((await t.request('DELETE', `/watchlist/${soon.id}`, { token: fan.token })).body).toEqual({ watching: false });
      expect((await t.request('GET', '/me/watchlist/ids', { token: fan.token })).body).toEqual([later.id]);
    });
  });

  describe('관리자', () => {
    it('권한 없으면 403, 중지/복구·신고·사용자 정지·감사 로그가 동작한다', async () => {
      const admin = await t.register('admin1');
      const seller = await t.register('seller10');
      const bidder = await t.register('bidder10');
      const reporter = await t.register('reporter10');

      expect((await t.request('GET', '/admin/stats', { token: seller.token })).status).toBe(403);
      // 토큰에 박힌 역할이 아니라 DB 역할을 쓰므로, 승격하면 같은 토큰으로 바로 통과해야 한다
      await M().User.updateOne({ _id: admin.id }, { $set: { role: 'admin' } });
      const stats = await t.request('GET', '/admin/stats', { token: admin.token });
      expect(stats.status).toBe(200);
      expect(stats.body.users).toBeGreaterThanOrEqual(4);

      // 신고 → 중지 처리
      const auction = await createAuction(seller.token, { title: '가짜 상품' });
      expect((await t.request('POST', `/auctions/${auction.id}/report`, { token: seller.token, body: { reason: '내 거 신고' } })).status).toBe(400);
      const rep = await t.request('POST', `/auctions/${auction.id}/report`, { token: reporter.token, body: { reason: '가짜 같아요' } });
      expect(rep.status).toBe(201);
      expect((await t.request('POST', `/auctions/${auction.id}/report`, { token: reporter.token, body: { reason: '또 신고함' } })).status).toBe(409);

      const reports = await t.request('GET', '/admin/reports?status=open', { token: admin.token });
      const report = reports.body.items.find((r: any) => r.auction.id === auction.id);
      expect(report).toMatchObject({ reason: '가짜 같아요', reporter: { nickname: 'reporter10' } });

      const sellerSocket = await t.connectSocket(seller.token);
      const notes = collect(sellerSocket, 'notify');
      const resolved = await t.request('POST', `/admin/reports/${report.id}/resolve`, {
        token: admin.token,
        body: { action: 'suspend', note: '허위 매물' },
      });
      expect(resolved.body).toMatchObject({ status: 'resolved', resolution: 'suspended' });
      expect((await notes.waitFor(1))[0]).toMatchObject({ type: 'suspended', message: '허위 매물' });

      // 중지된 경매: 입찰/즉시구매 거절, 공개 목록에서 숨김, 관리자 목록에는 사유와 함께 보임, 수정 불가
      expect((await bid(bidder.token, auction.id, 1000)).status).toBe(409);
      expect((await t.request('GET', '/auctions?q=가짜')).body.items).toHaveLength(0);
      const adminList = await t.request('GET', '/admin/auctions?suspended=true', { token: admin.token });
      expect(adminList.body.items.find((a: any) => a.id === auction.id)).toMatchObject({
        suspended: true,
        suspendedReason: '허위 매물',
      });
      expect((await t.request('GET', `/auctions/${auction.id}`)).body.suspendedReason).toBeNull(); // 공개 조회엔 사유 비노출
      expect((await t.request('PATCH', `/auctions/${auction.id}`, { token: seller.token, body: { title: 'x' } })).status).toBe(409);
      expect((await t.request('POST', `/admin/auctions/${auction.id}/suspend`, { token: admin.token, body: { reason: '이중' } })).status).toBe(409);

      // 중지 중에 종료돼도 정산되지 않다가, 복구하면 정산된다
      await expire(auction.id);
      await t.get<SettlementService>(SettlementService).sweep();
      expect((await t.request('GET', `/auctions/${auction.id}`)).body.result).toBeNull();

      expect((await t.request('POST', `/admin/auctions/${auction.id}/restore`, { token: admin.token })).body.suspended).toBe(false);
      await t.get<SettlementService>(SettlementService).sweep();
      expect((await t.request('GET', `/auctions/${auction.id}`)).body.result).toBe('unsold');

      // 사용자 정지: 로그인 거절 + 이미 발급된 토큰도 즉시 거절, 본인 변경 불가
      expect((await t.request('PATCH', `/admin/users/${admin.id}`, { token: admin.token, body: { role: 'buyer' } })).status).toBe(403);
      const ban = await t.request('PATCH', `/admin/users/${bidder.id}`, {
        token: admin.token,
        body: { status: 'banned', reason: '사기 의심' },
      });
      expect(ban.body).toMatchObject({ status: 'banned', bannedReason: '사기 의심' });
      expect((await t.request('POST', '/auth/login', { body: { email: bidder.email, password: 'password123' } })).status).toBe(403);
      expect((await t.request('GET', '/auth/me', { token: bidder.token })).status).toBe(403);
      const unban = await t.request('PATCH', `/admin/users/${bidder.id}`, { token: admin.token, body: { status: 'active' } });
      expect(unban.body).toMatchObject({ status: 'active', bannedReason: null });
      expect((await t.request('GET', '/auth/me', { token: bidder.token })).status).toBe(200);

      const users = await t.request('GET', '/admin/users?q=bidder10', { token: admin.token });
      expect(users.body.items).toHaveLength(1);

      const audit = await t.request('GET', '/admin/audit', { token: admin.token });
      const actions = audit.body.map((a: any) => a.action);
      expect(actions).toEqual(expect.arrayContaining(['auction.suspend', 'auction.restore', 'user.update', 'report.suspend']));
    });
  });

  describe('동시성', () => {
    it('25명이 동시에 서로 다른 금액으로 입찰해도 최고가 하나로 정합하다', async () => {
      const seller = await t.register('seller11');
      const auction = await createAuction(seller.token);
      const bidders = await Promise.all(Array.from({ length: 25 }, (_, i) => t.register(`racer${i}`)));

      // 금액: 1000, 1500, ... (모두 유효한 단위)
      const amounts = bidders.map((_, i) => 1000 + i * 500);
      const results = await Promise.all(bidders.map((u, i) => bid(u.token, auction.id, amounts[i])));

      const okAmounts = results.flatMap((r, i) => (r.status === 201 ? [amounts[i]] : []));
      const top = Math.max(...amounts);
      expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
      expect(okAmounts).toContain(top); // 가장 높은 입찰은 언제나 성공한다
      expect(new Set(okAmounts).size).toBe(okAmounts.length);

      const stored = await M().Auction.findById(auction.id).lean<any>();
      expect(stored.currentPrice).toBe(top);
      expect(stored.bidCount).toBe(okAmounts.length);
      expect(String(stored.highestBidderId)).toBe(bidders[amounts.indexOf(top)].id);

      const records = await M().Bid.find({ auctionId: auction.id }).lean<any[]>();
      expect(records).toHaveLength(okAmounts.length);
      expect(records.map((r) => r.amount).sort((a, b) => a - b)).toEqual([...okAmounts].sort((a, b) => a - b));
    }, 60_000);

    it('같은 사용자가 같은 금액으로 동시에 여러 번 눌러도 한 번만 반영된다', async () => {
      const seller = await t.register('seller12');
      const u = await t.register('doubleclick');
      const auction = await createAuction(seller.token);
      const results = await Promise.all(Array.from({ length: 10 }, () => bid(u.token, auction.id, 1000)));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect((await M().Auction.findById(auction.id).lean<any>()).bidCount).toBe(1);
      expect(await M().Bid.countDocuments({ auctionId: auction.id })).toBe(1);
    });

    it('즉시구매를 동시에 여러 명이 눌러도 한 명만 성공하고 주문은 하나', async () => {
      const seller = await t.register('seller13');
      const auction = await createAuction(seller.token, { buyNowPrice: 5000 });
      const buyers = await Promise.all(Array.from({ length: 8 }, (_, i) => t.register(`rush${i}`)));
      const results = await Promise.all(
        buyers.map((u) => t.request('POST', `/auctions/${auction.id}/buy-now`, { token: u.token })),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      await sleep(300);
      expect(await M().Order.countDocuments({ auctionId: auction.id })).toBe(1);
      expect((await M().Auction.findById(auction.id).lean<any>()).bidCount).toBe(1);
    }, 60_000);
  });

  describe('속도 제한 + 헬스체크', () => {
    const withThrottle = async (fn: () => Promise<void>) => {
      process.env.THROTTLE_DISABLED = 'false';
      try {
        await fn();
      } finally {
        process.env.THROTTLE_DISABLED = 'true';
      }
    };

    it('헬스체크는 DB가 살아 있으면 200', async () => {
      const res = await t.request('GET', '/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('로그인은 IP당 분당 10회까지, 넘으면 429', async () => {
      const u = await t.register('throttled1');
      await withThrottle(async () => {
        const codes: number[] = [];
        for (let i = 0; i < 12; i++) {
          codes.push((await t.request('POST', '/auth/login', { body: { email: u.email, password: 'wrong-password' } })).status);
        }
        expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
        expect(codes.slice(10)).toEqual([429, 429]);
      });
    });

    it('입찰은 사용자당 10초에 15회까지 — 한 사용자의 연타가 다른 사용자를 막지 않는다', async () => {
      const seller = await t.register('seller14');
      const spammer = await t.register('spammer');
      const honest = await t.register('honest');
      const auction = await createAuction(seller.token);
      await withThrottle(async () => {
        const codes: number[] = [];
        for (let i = 0; i < 17; i++) codes.push((await bid(spammer.token, auction.id, 1000)).status);
        expect(codes.filter((c) => c === 429).length).toBe(2);
        expect(codes.slice(15)).toEqual([429, 429]);
        // 다른 사용자는 같은 경매에 정상적으로 입찰할 수 있다
        expect((await bid(honest.token, auction.id, 1500)).status).toBe(201);
      });
    });
  });

  describe('인덱스', () => {
    it('유니크 인덱스가 실제로 걸려 있다', async () => {
      const unique = async (model: string, key: string) =>
        (await M()[model].collection.indexes()).some((i: any) => i.unique && key in i.key);
      expect(await unique('User', 'email')).toBe(true);
      expect(await unique('User', 'nickname')).toBe(true);
      expect(await unique('Order', 'auctionId')).toBe(true);
      expect(await unique('Watch', 'userId')).toBe(true);
      expect(await unique('Report', 'auctionId')).toBe(true);
      const ttl = (await M().Notification.collection.indexes()).find((i: any) => i.expireAfterSeconds);
      expect(ttl?.expireAfterSeconds).toBe(90 * 24 * 3600);
    });
  });
});
