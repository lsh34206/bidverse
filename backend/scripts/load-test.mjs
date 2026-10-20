// 동시 입찰 부하 테스트 + 정합성 검증.
//
//   npm run build && npm run load-test
//
// 동작:
//   1) 임시 DB(bidverse_load_*)를 쓰는 서버(dist/main.js)를 직접 띄운다 (속도 제한은 끔).
//   2) 사용자 N명을 만들고, 인기 경매 하나에 전원이 동시에 입찰을 쏟아붓는다.
//      (+ 마감 임박 경매에서는 스나이핑 방지 연장이 계속 일어나게 한다)
//   3) 끝나면 DB를 직접 읽어서 불변식을 검사한다:
//        - 성공한 입찰 수 == auction.bidCount == bids 컬렉션 문서 수
//        - 최종가 == 성공한 입찰 중 최대 금액, 최고가 입찰자도 일치
//        - 성공한 금액을 정렬하면 연속한 금액의 차이가 항상 최소 입찰 단위 이상 (가격 역전/중복 없음)
//        - 상회 입찰 알림 수 == 성공 수 - 1
//        - 구경꾼 소켓이 bid:new 를 빠짐없이 받음
//        - 종료 후 정산이 주문을 정확히 하나 만듦
//        - 5xx 응답 0건, 서버 로그에 ERROR 0건
//   4) 임시 DB를 지우고 서버를 종료한다.
//
// 환경변수 (모두 선택):
//   LOAD_BIDDERS=200   동시 입찰자 수
//   LOAD_SECONDS=15    입찰 부하를 거는 시간
//   LOAD_WATCHERS=100  실시간 구경꾼 소켓 수
//   LOAD_PORT=3999     테스트 서버 포트
//
// 주의: 부하를 거는 쪽과 서버가 같은 PC에서 CPU를 나눠 쓰고, DB는 실제 MongoDB(MONGODB_URI)라서
//       네트워크 지연이 그대로 반영된다. 절대 수치보다 "정합성 불변식 통과 여부"가 핵심 결과다.
import { spawn } from 'node:child_process';
import mongoose from 'mongoose';
import { io } from 'socket.io-client';

try {
  process.loadEnvFile('.env');
} catch {
  // .env 가 없으면 이미 주입된 환경변수를 쓴다.
}

const BIDDERS = Number(process.env.LOAD_BIDDERS) || 200;
const SECONDS = Number(process.env.LOAD_SECONDS) || 15;
const WATCHERS = Number(process.env.LOAD_WATCHERS) || 100;
const PORT = Number(process.env.LOAD_PORT) || 3999;
const BASE = `http://127.0.0.1:${PORT}/api`;
const DB = `bidverse_load_${Date.now()}`;
const MIN_INC = 100;
const START_PRICE = 1000;
const MAX_EXTENSIONS = 20;
const SNIPING_WINDOW_MS = 5 * 60 * 1000;

if (!process.env.MONGODB_URI) {
  console.error('MONGODB_URI 가 설정되어 있지 않음 (backend/.env)');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);
const fmtMs = (n) => `${n.toFixed(0)}ms`;
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

// ---------------------------------------------------------------- 서버 기동
const serverLog = [];
const server = spawn(process.execPath, ['dist/main.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    MONGODB_DB: DB,
    THROTTLE_DISABLED: 'true',
    DISABLE_SCHEDULERS: 'false',
    NODE_ENV: 'production',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => serverLog.push(d.toString()));
server.stderr.on('data', (d) => serverLog.push(d.toString()));
let serverExited = false;
server.on('exit', () => (serverExited = true));

async function api(method, path, { token, body } = {}) {
  const started = performance.now();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json, ms: performance.now() - started };
}

async function pool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try {
    if (DB.startsWith('bidverse_load_') && mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
      console.log(`\n임시 DB 삭제: ${DB}`);
    }
  } catch (err) {
    console.error(`임시 DB 삭제 실패(수동 정리: npm run db:clean-temp): ${err.message}`);
  }
  await mongoose.disconnect().catch(() => {});
  if (!serverExited) {
    server.kill('SIGTERM');
    await Promise.race([new Promise((r) => server.once('exit', r)), sleep(5000)]);
  }
}
process.on('SIGINT', async () => {
  await cleanup();
  process.exit(130);
});

try {
  // 서버가 뜰 때까지 기다린다.
  for (let i = 0; ; i++) {
    if (serverExited) throw new Error(`서버가 시작 중 종료됨:\n${serverLog.join('').slice(-1500)}`);
    try {
      if ((await fetch(`${BASE}/health`)).status === 200) break;
    } catch {
      // 아직 안 떴다.
    }
    if (i > 80) throw new Error('서버가 20초 안에 뜨지 않음');
    await sleep(250);
  }
  await mongoose.connect(process.env.MONGODB_URI, { dbName: DB, serverSelectionTimeoutMS: 15_000 });
  const M = mongoose.connection;
  console.log(`서버 기동 완료 (:${PORT}, 임시 DB ${DB})`);
  console.log(`설정: 입찰자 ${BIDDERS}명, ${SECONDS}초, 구경꾼 소켓 ${WATCHERS}개\n`);

  // ------------------------------------------------------------ 준비: 사용자/경매
  process.stdout.write('사용자 생성 중... ');
  const t0 = performance.now();
  const stamp = Date.now();
  const mk = async (name) => {
    const r = await api('POST', '/auth/register', {
      body: { email: `${name}-${stamp}@load.test`, password: 'password123', nickname: name },
    });
    if (r.status !== 201) throw new Error(`register ${name} 실패: ${r.status} ${JSON.stringify(r.body)}`);
    return { id: r.body.user.id, token: r.body.accessToken, name };
  };
  const seller = await mk('seller');
  const bidders = await pool(Array.from({ length: BIDDERS }, (_, i) => `b${i}`), 16, mk);
  console.log(`${BIDDERS + 1}명, ${fmtMs(performance.now() - t0)}`);

  const mkAuction = async (title, endsInMs) => {
    const r = await api('POST', '/auctions', {
      token: seller.token,
      body: {
        title,
        startPrice: START_PRICE,
        minIncrement: MIN_INC,
        endsAt: new Date(Date.now() + endsInMs).toISOString(),
      },
    });
    if (r.status !== 201) throw new Error(`경매 생성 실패: ${JSON.stringify(r.body)}`);
    return r.body.id;
  };
  const hot = await mkAuction('인기 경매', 2 * 3600_000);
  const sniping = await mkAuction('마감 임박 경매', 2 * 60_000);

  // ------------------------------------------------------------ 구경꾼 소켓
  const received = new Map(); // watcher index -> bid:new 개수 (hot 경매)
  const watchers = [];
  process.stdout.write('구경꾼 소켓 연결 중... ');
  await pool(Array.from({ length: WATCHERS }, (_, i) => i), 25, async (i) => {
    const socket = io(`http://127.0.0.1:${PORT}`, { transports: ['websocket'], forceNew: true });
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    received.set(i, 0);
    socket.on('bid:new', (e) => e.auctionId === hot && received.set(i, received.get(i) + 1));
    await socket.emitWithAck('auction:join', { auctionId: hot });
    watchers.push(socket);
  });
  console.log(`${watchers.length}개`);

  // ------------------------------------------------------------ 부하
  console.log(`\n입찰 부하 ${SECONDS}초 시작...`);
  const successes = new Map(); // auctionId -> [{amount, bidder}]
  successes.set(hot, []);
  successes.set(sniping, []);
  const stats = { codes: {}, latencies: [], reads: [] };
  const deadline = Date.now() + SECONDS * 1000;
  const loadStart = performance.now();

  const worker = async (u, idx) => {
    await sleep(Math.random() * 300); // 한꺼번에 시작하지 않게 살짝 흩뜨린다
    while (Date.now() < deadline) {
      // 마감 임박 경매에는 일부 입찰자만 참여한다
      const target = idx % 5 === 0 ? sniping : hot;
      const cur = await api('GET', `/auctions/${target}`);
      stats.reads.push(cur.ms);
      if (cur.status === 200) {
        // 최소가에 0~3단위를 더해 경합이 생기게 한다
        const amount = cur.body.minNextBid + MIN_INC * Math.floor(Math.random() * 4);
        const r = await api('POST', `/auctions/${target}/bids`, { token: u.token, body: { amount } });
        stats.codes[r.status] = (stats.codes[r.status] ?? 0) + 1;
        stats.latencies.push(r.ms);
        if (r.status === 201) successes.get(target).push({ amount, bidder: u.id, at: Date.now() });
      }
      await sleep(30 + Math.random() * 120);
    }
  };
  await Promise.all(bidders.map(worker));
  const elapsed = (performance.now() - loadStart) / 1000;

  const total = stats.latencies.length;
  const sortedLat = [...stats.latencies].sort((a, b) => a - b);
  const sortedRead = [...stats.reads].sort((a, b) => a - b);
  console.log(`\n── 결과 (${elapsed.toFixed(1)}초) ──`);
  console.log(`  입찰 요청 ${total}건 → 처리량 ${(total / elapsed).toFixed(0)} req/s`);
  console.log(`  상태 코드: ${Object.entries(stats.codes).map(([c, n]) => `${c}×${n}`).join('  ')}`);
  console.log(
    `  입찰 지연  p50 ${fmtMs(pct(sortedLat, 50))}  p95 ${fmtMs(pct(sortedLat, 95))}  p99 ${fmtMs(pct(sortedLat, 99))}  max ${fmtMs(sortedLat.at(-1) ?? 0)}`,
  );
  console.log(
    `  조회 지연  p50 ${fmtMs(pct(sortedRead, 50))}  p95 ${fmtMs(pct(sortedRead, 95))}  p99 ${fmtMs(pct(sortedRead, 99))}  (${sortedRead.length}건)`,
  );

  // 소켓 이벤트가 다 도착할 시간을 잠깐 준다
  await sleep(1500);

  // ------------------------------------------------------------ 정합성 검증
  console.log('\n── 정합성 검증 ──');
  const server5xx = Object.entries(stats.codes).filter(([c]) => Number(c) >= 500).reduce((s, [, n]) => s + n, 0);
  const unexpected = Object.entries(stats.codes).filter(([c]) => !['201', '409'].includes(c));
  check('5xx 응답 0건', server5xx === 0, `${server5xx}건`);
  check('예상 밖 상태 코드 없음 (201/409만)', unexpected.length === 0, unexpected.map(([c, n]) => `${c}×${n}`).join(' '));

  for (const [label, id] of [['인기 경매', hot], ['마감 임박 경매', sniping]]) {
    const ok = successes.get(id);
    console.log(`\n[${label}] 성공한 입찰 ${ok.length}건`);
    const auction = await M.collection('auctions').findOne({ _id: new mongoose.Types.ObjectId(id) });
    const bidDocs = await M.collection('bids').countDocuments({ auctionId: new mongoose.Types.ObjectId(id) });
    const amounts = ok.map((s) => s.amount).sort((a, b) => a - b);
    const top = amounts.at(-1);

    check('auction.bidCount == 성공 수', auction.bidCount === ok.length, `${auction.bidCount} vs ${ok.length}`);
    check('bids 컬렉션 문서 수 == 성공 수', bidDocs === ok.length, `${bidDocs} vs ${ok.length}`);
    check('최종가 == 성공한 입찰 중 최대 금액', auction.currentPrice === top, `${auction.currentPrice} vs ${top}`);
    const topBidder = ok.find((s) => s.amount === top)?.bidder;
    check('최고가 입찰자 일치', String(auction.highestBidderId) === topBidder);
    check('성공한 금액에 중복 없음', new Set(amounts).size === amounts.length);
    const gapOk = amounts.every((a, i) => (i === 0 ? a >= START_PRICE : a - amounts[i - 1] >= MIN_INC));
    check(`연속한 성공 금액의 차이가 항상 최소 단위(${MIN_INC}) 이상 (가격 역전 없음)`, gapOk);
    const outbids = await M.collection('notifications').countDocuments({
      type: 'outbid',
      auctionId: new mongoose.Types.ObjectId(id),
    });
    check('상회 입찰 알림 수 == 성공 수 - 1', outbids === Math.max(0, ok.length - 1), `${outbids} vs ${ok.length - 1}`);

    if (id === sniping) {
      check(`연장 횟수 상한(${MAX_EXTENSIONS}) 준수`, auction.extensionCount <= MAX_EXTENSIONS, `${auction.extensionCount}회`);
      const lastBidAt = Math.max(...ok.map((s) => s.at));
      check(
        '종료 시각이 마지막 입찰 + 5분을 넘지 않음',
        new Date(auction.endsAt).getTime() <= lastBidAt + SNIPING_WINDOW_MS + 2000,
        `연장 ${auction.extensionCount}회`,
      );
    }
  }

  const hotOk = successes.get(hot).length;
  const counts = [...received.values()];
  const missing = counts.filter((n) => n !== hotOk).length;
  console.log(`\n[실시간] 구경꾼 ${watchers.length}명`);
  check(
    `모든 구경꾼이 bid:new ${hotOk}건을 빠짐없이 수신`,
    missing === 0,
    missing ? `불일치 ${missing}명, 최소 ${Math.min(...counts)} / 최대 ${Math.max(...counts)}` : '',
  );

  // ------------------------------------------------------------ 정산
  console.log('\n[정산] 인기 경매를 종료시키고 스케줄러가 처리하는지 확인');
  await M.collection('auctions').updateOne(
    { _id: new mongoose.Types.ObjectId(hot) },
    { $set: { endsAt: new Date(Date.now() - 1000) } },
  );
  let orders = 0;
  const settleStart = Date.now();
  while (Date.now() - settleStart < 15_000) {
    orders = await M.collection('orders').countDocuments({ auctionId: new mongoose.Types.ObjectId(hot) });
    if (orders > 0) break;
    await sleep(500);
  }
  await sleep(1500); // 중복 생성이 없는지 조금 더 지켜본다
  orders = await M.collection('orders').countDocuments({ auctionId: new mongoose.Types.ObjectId(hot) });
  const settled = await M.collection('auctions').findOne({ _id: new mongoose.Types.ObjectId(hot) });
  check('정산 스케줄러가 주문을 정확히 하나 생성', orders === 1, `${orders}건, ${((Date.now() - settleStart) / 1000).toFixed(1)}초 소요`);
  check('경매 결과가 sold', settled?.result === 'sold');
  const wonNotes = await M.collection('notifications').countDocuments({
    type: 'won',
    auctionId: new mongoose.Types.ObjectId(hot),
  });
  check('낙찰 알림이 정확히 한 번', wonNotes === 1, `${wonNotes}건`);

  const errLines = serverLog.join('').split('\n').filter((l) => /\bERROR\b/.test(l));
  check('서버 로그에 ERROR 없음', errLines.length === 0, errLines.length ? errLines[0].slice(0, 160) : '');

  watchers.forEach((s) => s.disconnect());
} catch (err) {
  console.error(`\n부하 테스트 중단: ${err.stack ?? err}`);
  checks.push({ name: '실행 중 예외 없음', ok: false });
} finally {
  await cleanup();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${failed.length === 0 ? '모든 검증 통과' : `검증 실패 ${failed.length}건`} (${checks.length}개 중)`);
process.exit(failed.length === 0 ? 0 : 1);
