import { collect, inFuture, joinAuction, sleep, startApp, type TestApp } from './helpers.js';

/** 경매 채팅을 실제 MongoDB + 실제 Socket.IO 연결로 검증한다. */
describe('경매 채팅 E2E (실제 MongoDB)', () => {
  let t: TestApp;
  const M = () => t.connection.models;

  beforeAll(async () => {
    t = await startApp();
  }, 60_000);

  afterAll(async () => {
    await t?.close();
  }, 60_000);

  const createAuction = async (token: string, over: Record<string, unknown> = {}) => {
    const res = await t.request('POST', '/auctions', {
      token,
      body: { title: '채팅 테스트 경매', startPrice: 1000, endsAt: inFuture(2 * 3600_000), ...over },
    });
    return res.body.id as string;
  };
  const say = (token: string | undefined, auctionId: string, text: string) =>
    t.request('POST', `/auctions/${auctionId}/chat`, { token, body: { text } });
  const history = (auctionId: string, query = '') => t.request('GET', `/auctions/${auctionId}/chat${query}`);

  it('로그인 없이 내역은 볼 수 있고, 보내려면 로그인이 필요하다', async () => {
    const seller = await t.register('chatseller1');
    const auctionId = await createAuction(seller.token);
    expect((await history(auctionId)).body).toEqual({ items: [], hasMore: false });
    expect((await say(undefined, auctionId, '안녕하세요')).status).toBe(401);
  });

  it('보낸 메시지가 저장되고, 방에 있는 사람 전원(본인 포함)에게 실시간으로 전달된다', async () => {
    const seller = await t.register('chatseller2');
    const alice = await t.register('chatalice');
    const bob = await t.register('chatbob');
    const auctionId = await createAuction(seller.token);

    const aliceSocket = await t.connectSocket(alice.token);
    const bobSocket = await t.connectSocket(bob.token);
    const lurker = await t.connectSocket(); // 로그인하지 않은 구경꾼
    const outsider = await t.connectSocket(bob.token); // 다른 경매를 보는 사람
    for (const s of [aliceSocket, bobSocket, lurker]) await joinAuction(s, auctionId);
    await joinAuction(outsider, await createAuction(seller.token));
    const onAlice = collect(aliceSocket, 'chat:new');
    const onBob = collect(bobSocket, 'chat:new');
    const onLurker = collect(lurker, 'chat:new');
    const onOutsider = collect(outsider, 'chat:new');

    const res = await say(alice.token, auctionId, '  이거 실제 사진인가요?  ');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      auctionId,
      userId: alice.id,
      nickname: 'chatalice',
      text: '이거 실제 사진인가요?',
      isSeller: false,
      isAdmin: false,
    });

    for (const got of [onAlice, onBob, onLurker]) expect((await got.waitFor(1))[0]).toMatchObject({ id: res.body.id, text: '이거 실제 사진인가요?' });
    await sleep(200);
    expect(onOutsider.events).toHaveLength(0);

    const hist = await history(auctionId);
    expect(hist.body.items.map((m: any) => m.text)).toEqual(['이거 실제 사진인가요?']);
  });

  it('판매자/관리자 배지, 입력 검증(빈 값·300자 초과·제어문자)', async () => {
    const seller = await t.register('chatseller3');
    const admin = await t.register('chatadmin');
    await M().User.updateOne({ _id: admin.id }, { $set: { role: 'admin' } });
    const auctionId = await createAuction(seller.token);

    expect((await say(seller.token, auctionId, '문의 주세요')).body.isSeller).toBe(true);
    expect((await say(admin.token, auctionId, '운영자입니다')).body.isAdmin).toBe(true);

    expect((await say(seller.token, auctionId, '   ')).status).toBe(400);
    expect((await say(seller.token, auctionId, '가'.repeat(301))).status).toBe(400);
    expect((await say(seller.token, auctionId, '가'.repeat(300))).status).toBe(201);
    expect((await say(seller.token, auctionId, '숨\u0000은 문자')).body.text).toBe('숨은 문자');
    expect((await t.request('POST', `/auctions/${auctionId}/chat`, { token: seller.token, body: {} })).status).toBe(400);
  });

  it('페이지네이션: 최근 것부터 끊어 읽고, before 로 이전 메시지를 이어서 읽는다 (오래된 순 정렬)', async () => {
    const seller = await t.register('chatseller4');
    const auctionId = await createAuction(seller.token);
    for (let i = 1; i <= 7; i++) await say(seller.token, auctionId, `메시지 ${i}`);

    const page1 = (await history(auctionId, '?limit=3')).body;
    expect(page1.items.map((m: any) => m.text)).toEqual(['메시지 5', '메시지 6', '메시지 7']);
    expect(page1.hasMore).toBe(true);

    const page2 = (await history(auctionId, `?limit=3&before=${page1.items[0].id}`)).body;
    expect(page2.items.map((m: any) => m.text)).toEqual(['메시지 2', '메시지 3', '메시지 4']);
    expect(page2.hasMore).toBe(true);

    const page3 = (await history(auctionId, `?limit=3&before=${page2.items[0].id}`)).body;
    expect(page3.items.map((m: any) => m.text)).toEqual(['메시지 1']);
    expect(page3.hasMore).toBe(false);

    expect((await history(auctionId, '?before=not-an-id')).status).toBe(400);
    expect((await history(auctionId, '?limit=0')).status).toBe(400);
  });

  it('삭제: 작성자·판매자·관리자만 가능하고, 삭제는 방 전체에 알려지며 내역에서 사라진다', async () => {
    const seller = await t.register('chatseller5');
    const alice = await t.register('chatalice5');
    const stranger = await t.register('chatstranger5');
    const admin = await t.register('chatadmin5');
    await M().User.updateOne({ _id: admin.id }, { $set: { role: 'admin' } });
    const auctionId = await createAuction(seller.token);
    const watcher = await t.connectSocket();
    await joinAuction(watcher, auctionId);
    const deletedEvents = collect(watcher, 'chat:deleted');

    const mine = (await say(alice.token, auctionId, '내가 쓴 글')).body;
    const spam = (await say(alice.token, auctionId, '광고 글')).body;
    const another = (await say(alice.token, auctionId, '또 다른 글')).body;
    const del = (who: { token: string } | undefined, id: string) =>
      t.request('DELETE', `/auctions/${auctionId}/chat/${id}`, { token: who?.token });

    expect((await del(undefined, mine.id)).status).toBe(401);
    expect((await del(stranger, mine.id)).status).toBe(403); // 관계없는 사용자
    expect((await del(alice, mine.id)).status).toBe(204); // 작성자
    expect((await del(seller, spam.id)).status).toBe(204); // 이 경매의 판매자
    expect((await del(admin, another.id)).status).toBe(204); // 관리자
    expect((await del(alice, mine.id)).status).toBe(404); // 이미 지워짐

    expect((await deletedEvents.waitFor(3)).map((e: any) => e.messageId).sort()).toEqual([mine.id, spam.id, another.id].sort());
    expect((await history(auctionId)).body.items).toHaveLength(0);
    // 지우지 않고 표시만 한다 (누가 지웠는지 남는다)
    const raw = await M().ChatMessage.findById(spam.id).lean<any>();
    expect(raw.deletedAt).toBeTruthy();
    expect(String(raw.deletedBy)).toBe(seller.id);

    // 다른 경매의 판매자는 이 경매 메시지를 지울 수 없다
    const otherSeller = await t.register('chatseller5b');
    await createAuction(otherSeller.token);
    const fresh = (await say(alice.token, auctionId, '새 글')).body;
    expect((await del(otherSeller, fresh.id)).status).toBe(403);
  });

  it('종료된 경매와 관리자에 의해 중지된 경매는 읽기 전용이다', async () => {
    const seller = await t.register('chatseller6');
    const alice = await t.register('chatalice6');
    const auctionId = await createAuction(seller.token);
    expect((await say(alice.token, auctionId, '마감 전에 남긴 글')).status).toBe(201);

    await M().Auction.updateOne({ _id: auctionId }, { $set: { suspended: true } });
    expect((await say(alice.token, auctionId, '중지 중 글')).status).toBe(409);
    await M().Auction.updateOne({ _id: auctionId }, { $set: { suspended: false, endsAt: new Date(Date.now() - 1000) } });
    expect((await say(alice.token, auctionId, '종료 후 글')).status).toBe(409);

    // 읽는 것은 계속 된다
    expect((await history(auctionId)).body.items.map((m: any) => m.text)).toEqual(['마감 전에 남긴 글']);
    expect((await say(alice.token, 'a'.repeat(24), '없는 경매')).status).toBe(404);
  });

  it('시작 전 경매에서는 판매자에게 질문할 수 있다', async () => {
    const seller = await t.register('chatseller7');
    const alice = await t.register('chatalice7');
    const auctionId = await createAuction(seller.token, { startsAt: inFuture(3600_000), endsAt: inFuture(3 * 3600_000) });
    expect((await say(alice.token, auctionId, '직거래 가능한가요?')).status).toBe(201);
  });

  it('정지된 사용자는 채팅을 보낼 수 없다', async () => {
    const seller = await t.register('chatseller8');
    const troll = await t.register('chattroll');
    const auctionId = await createAuction(seller.token);
    expect((await say(troll.token, auctionId, '정상 글')).status).toBe(201);
    await M().User.updateOne({ _id: troll.id }, { $set: { status: 'banned' } });
    // (DB 직접 변경은 인증 캐시 때문에 최대 5초 늦게 반영되므로, 캐시를 거치지 않는 새 사용자로 확인한다)
    const second = await t.register('chattroll2');
    await M().User.updateOne({ _id: second.id }, { $set: { status: 'banned' } });
    expect((await say(second.token, auctionId, '정지된 계정')).status).toBe(403);
  });

  it('도배 제한: 한 사용자가 10초에 6건을 넘기면 429, 다른 사용자는 영향 없음', async () => {
    const seller = await t.register('chatseller9');
    const spammer = await t.register('chatspammer');
    const honest = await t.register('chathonest');
    const auctionId = await createAuction(seller.token);
    process.env.THROTTLE_DISABLED = 'false';
    try {
      const codes: number[] = [];
      for (let i = 0; i < 8; i++) codes.push((await say(spammer.token, auctionId, `도배 ${i}`)).status);
      expect(codes.slice(0, 6).every((c) => c === 201)).toBe(true);
      expect(codes.slice(6)).toEqual([429, 429]);
      expect((await say(honest.token, auctionId, '저는 정상이에요')).status).toBe(201);
    } finally {
      process.env.THROTTLE_DISABLED = 'true';
    }
  });

  it('접속자 수: 경매방에 들어오고 나가면 방 전체에 집계가 알려진다', async () => {
    const seller = await t.register('chatseller10');
    const auctionId = await createAuction(seller.token);
    const first = await t.connectSocket();
    const viewers = collect<{ auctionId: string; count: number }>(first, 'auction:viewers');
    await joinAuction(first, auctionId);
    const second = await t.connectSocket();
    const third = await t.connectSocket();
    await joinAuction(second, auctionId);
    await joinAuction(third, auctionId);

    const waitFor = async (cond: () => boolean) => {
      for (let i = 0; i < 120 && !cond(); i++) await sleep(25);
      expect(cond()).toBe(true);
    };
    await waitFor(() => viewers.events.some((v) => v.count === 3));
    second.disconnect();
    await waitFor(() => viewers.events.at(-1)?.count === 2);
    expect(viewers.events.every((v) => v.auctionId === auctionId)).toBe(true);
  });

  it('인덱스: 최근 메시지 조회용 복합 인덱스와 보관 기간(TTL)이 걸려 있다', async () => {
    const indexes = await M().ChatMessage.collection.indexes();
    expect(indexes.some((i: any) => i.key.auctionId === 1 && i.key._id === -1)).toBe(true);
    expect(indexes.find((i: any) => i.expireAfterSeconds)?.expireAfterSeconds).toBe(90 * 24 * 3600);
  });
});
