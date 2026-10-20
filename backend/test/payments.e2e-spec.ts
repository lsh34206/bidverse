import { PaymentsReconcileService } from '../src/payments/payments-reconcile.service.js';
import { SettlementService } from '../src/settlement/settlement.service.js';
import { FakeToss } from './fake-toss.js';
import { inFuture, startApp, type TestApp } from './helpers.js';

/**
 * 토스페이먼츠 결제 흐름을 실제 MongoDB + 토스 API 모양의 가짜 서버로 검증한다. (실제 토스는 호출하지 않는다)
 */
describe('토스페이먼츠 결제 E2E', () => {
  let t: TestApp;
  const toss = new FakeToss();
  const M = () => t.connection.models;
  let seq = 0;

  beforeAll(async () => {
    await toss.start();
    t = await startApp({
      TOSS_CLIENT_KEY: 'test_gck_fake_client',
      TOSS_SECRET_KEY: toss.secretKey,
      TOSS_API_BASE: toss.baseUrl,
    });
  }, 60_000);

  afterAll(async () => {
    await t?.close();
    await toss.stop();
  }, 60_000);

  /** 낙찰까지 끝나 결제 대기 상태인 주문 하나를 만든다 */
  const makeOrder = async (price = 25_000) => {
    const n = ++seq;
    const seller = await t.register(`pseller${n}`);
    const buyer = await t.register(`pbuyer${n}`);
    const created = await t.request('POST', '/auctions', {
      token: seller.token,
      body: { title: `결제 테스트 상품 ${n}`, startPrice: price, endsAt: inFuture(3600_000) },
    });
    const auctionId = created.body.id;
    await t.request('POST', `/auctions/${auctionId}/bids`, { token: buyer.token, body: { amount: price } });
    await M().Auction.updateOne({ _id: auctionId }, { $set: { endsAt: new Date(Date.now() - 1000) } });
    await t.get<SettlementService>(SettlementService).sweep();
    const order = (await t.request('GET', '/me/orders', { token: buyer.token })).body[0];
    return { seller, buyer, order, price };
  };

  const prepare = (token: string, orderId: string) =>
    t.request('POST', `/orders/${orderId}/payment`, { token });
  const confirm = (token: string, body: { paymentKey: string; orderId: string; amount: number }) =>
    t.request('POST', '/payments/confirm', { token, body });
  const key = () => `pk_${Date.now()}_${++seq}`;

  /** 준비 → (결제창에서 인증 완료) → 승인 까지 */
  const payFully = async (ctx: Awaited<ReturnType<typeof makeOrder>>) => {
    const prep = (await prepare(ctx.buyer.token, ctx.order.id)).body;
    const paymentKey = key();
    toss.authorize(prep.orderId, paymentKey, prep.amount);
    const res = await confirm(ctx.buyer.token, { paymentKey, orderId: prep.orderId, amount: prep.amount });
    return { prep, paymentKey, res };
  };

  describe('결제 준비', () => {
    it('구매자에게만 주문번호/금액을 내려주고, 같은 주문의 준비는 재사용한다', async () => {
      const ctx = await makeOrder(31_000);
      const stranger = await t.register('pstranger');

      expect((await prepare(stranger.token, ctx.order.id)).status).toBe(404);
      expect((await prepare(ctx.seller.token, ctx.order.id)).status).toBe(404); // 판매자도 결제할 수 없다
      expect((await t.request('POST', `/orders/${ctx.order.id}/payment`)).status).toBe(401);

      const res = await prepare(ctx.buyer.token, ctx.order.id);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        mode: 'toss',
        clientKey: 'test_gck_fake_client',
        amount: 31_000,
      });
      expect(res.body.orderId).toMatch(/^[A-Za-z0-9_=-]{6,64}$/);
      expect(res.body.orderName).toContain('결제 테스트 상품');
      // customerKey: 사용자 id를 그대로 노출하지 않는 안정적인 값
      expect(res.body.customerKey).toMatch(/^bv_[0-9a-f]{32}$/);
      expect(res.body.customerKey).not.toContain(ctx.buyer.id);
      const again = await prepare(ctx.buyer.token, ctx.order.id);
      expect(again.body.orderId).toBe(res.body.orderId);
      expect(again.body.customerKey).toBe(res.body.customerKey);
      expect(await M().Payment.countDocuments({ orderId: ctx.order.id })).toBe(1);
    });
  });

  describe('결제 승인', () => {
    it('정상 결제: 토스에 올바른 인증/멱등키로 승인 요청하고 주문이 paid, 판매자에게 알림', async () => {
      const ctx = await makeOrder(42_000);
      const before = toss.count('POST', '/v1/payments/confirm');

      const { prep, paymentKey, res } = await payFully(ctx);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('paid');
      expect(res.body.order).toMatchObject({ id: ctx.order.id, status: 'paid', finalPrice: 42_000 });
      expect(res.body.receiptUrl).toContain(paymentKey);

      // 토스로 나간 요청 검증
      const sent = toss.last('POST', '/v1/payments/confirm')!;
      expect(toss.count('POST', '/v1/payments/confirm')).toBe(before + 1);
      expect(sent.body).toEqual({ paymentKey, orderId: prep.orderId, amount: 42_000 });
      expect(sent.headers.authorization).toBe(`Basic ${Buffer.from(`${toss.secretKey}:`).toString('base64')}`);
      expect(String(sent.headers['idempotency-key']).length).toBeGreaterThan(10);

      const payment = await M().Payment.findOne({ tossOrderId: prep.orderId }).lean<any>();
      expect(payment).toMatchObject({ status: 'done', paymentKey, method: '카드', amount: 42_000 });
      expect(payment.orderSyncedAt).toBeTruthy();

      const inbox = await t.request('GET', '/me/notifications', { token: ctx.seller.token });
      expect(inbox.body.items.map((n: any) => n.type)).toContain('paid');
    });

    it('같은 승인 요청을 다시 보내도(새로고침) 토스를 다시 호출하지 않고 같은 결과', async () => {
      const ctx = await makeOrder();
      const { prep, paymentKey } = await payFully(ctx);
      const calls = toss.count('POST', '/v1/payments/confirm');

      const again = await confirm(ctx.buyer.token, { paymentKey, orderId: prep.orderId, amount: prep.amount });
      expect(again.status).toBe(200);
      expect(again.body.status).toBe('paid');
      expect(toss.count('POST', '/v1/payments/confirm')).toBe(calls);

      // 다른 paymentKey 로 같은 주문번호를 승인하려 하면 거절
      const other = await confirm(ctx.buyer.token, { paymentKey: key(), orderId: prep.orderId, amount: prep.amount });
      expect(other.status).toBe(409);
    });

    it('금액 변조: 클라이언트가 다른 금액을 보내면 토스에 요청도 보내지 않고 거절', async () => {
      const ctx = await makeOrder(50_000);
      const prep = (await prepare(ctx.buyer.token, ctx.order.id)).body;
      const paymentKey = key();
      toss.authorize(prep.orderId, paymentKey, 100); // 결제창에서 100원만 인증하고
      const before = toss.count('POST', '/v1/payments/confirm');

      const res = await confirm(ctx.buyer.token, { paymentKey, orderId: prep.orderId, amount: 100 });

      expect(res.status).toBe(400);
      expect(toss.count('POST', '/v1/payments/confirm')).toBe(before); // 승인 요청 자체를 보내지 않음
      expect((await t.request('GET', `/orders/${ctx.order.id}`, { token: ctx.buyer.token })).body.status).toBe('pending');
      expect((await M().Payment.findOne({ tossOrderId: prep.orderId }).lean<any>()).status).toBe('ready');
    });

    it('다른 사람의 결제 시도는 승인할 수 없다', async () => {
      const ctx = await makeOrder();
      const intruder = await t.register('pintruder');
      const prep = (await prepare(ctx.buyer.token, ctx.order.id)).body;
      const paymentKey = key();
      toss.authorize(prep.orderId, paymentKey, prep.amount);
      const res = await confirm(intruder.token, { paymentKey, orderId: prep.orderId, amount: prep.amount });
      expect(res.status).toBe(404);
    });

    it('토스가 거절하면(카드사 거절 등) 실패로 기록하고 주문은 결제 대기 그대로, 다시 시도할 수 있다', async () => {
      const ctx = await makeOrder();
      const prep = (await prepare(ctx.buyer.token, ctx.order.id)).body;
      const paymentKey = key();
      toss.authorize(prep.orderId, paymentKey, prep.amount);
      toss.failNextConfirm = { status: 400, code: 'REJECT_CARD_COMPANY', message: '카드사에서 결제를 거절했습니다.' };

      const res = await confirm(ctx.buyer.token, { paymentKey, orderId: prep.orderId, amount: prep.amount });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('REJECT_CARD_COMPANY');

      const failed = await M().Payment.findOne({ tossOrderId: prep.orderId }).lean<any>();
      expect(failed).toMatchObject({ status: 'failed', failure: { code: 'REJECT_CARD_COMPANY' } });
      expect((await t.request('GET', `/orders/${ctx.order.id}`, { token: ctx.buyer.token })).body.status).toBe('pending');

      // 실패한 시도는 재사용되지 않고 새 시도로 다시 결제할 수 있다
      const retry = await payFully(ctx);
      expect(retry.prep.orderId).not.toBe(prep.orderId);
      expect(retry.res.body.status).toBe('paid');
    });

    it('승인은 됐는데 응답이 유실되면: 재시도(같은 멱등키)로 중복 결제 없이 완료된다', async () => {
      const ctx = await makeOrder();
      const prep = (await prepare(ctx.buyer.token, ctx.order.id)).body;
      const paymentKey = key();
      toss.authorize(prep.orderId, paymentKey, prep.amount);
      toss.dropNextConfirmResponse = true;

      const first = await confirm(ctx.buyer.token, { paymentKey, orderId: prep.orderId, amount: prep.amount });
      expect(first.status).toBe(503);
      // 실패로 단정하지 않는다: 'confirming'으로 남고 주문은 아직 결제 대기
      expect((await M().Payment.findOne({ tossOrderId: prep.orderId }).lean<any>()).status).toBe('confirming');
      expect((await t.request('GET', `/orders/${ctx.order.id}`, { token: ctx.buyer.token })).body.status).toBe('pending');

      const retry = await confirm(ctx.buyer.token, { paymentKey, orderId: prep.orderId, amount: prep.amount });
      expect(retry.status).toBe(200);
      expect(retry.body.status).toBe('paid');
      const sentKeys = toss.requests
        .filter((r) => r.path === '/v1/payments/confirm' && r.body.orderId === prep.orderId)
        .map((r) => r.headers['idempotency-key']);
      expect(sentKeys).toHaveLength(2);
      expect(sentKeys[0]).toBe(sentKeys[1]); // 같은 멱등키
    });

    it('응답이 유실되고 사용자가 돌아오지 않아도 대사 작업이 토스에서 조회해 주문을 결제 완료로 맞춘다', async () => {
      const ctx = await makeOrder();
      const prep = (await prepare(ctx.buyer.token, ctx.order.id)).body;
      const paymentKey = key();
      toss.authorize(prep.orderId, paymentKey, prep.amount);
      toss.dropNextConfirmResponse = true;
      expect((await confirm(ctx.buyer.token, { paymentKey, orderId: prep.orderId, amount: prep.amount })).status).toBe(503);

      const reconcile = t.get<PaymentsReconcileService>(PaymentsReconcileService);
      // 아직 2분이 안 지났으면 건드리지 않는다
      await reconcile.sweep();
      expect((await M().Payment.findOne({ tossOrderId: prep.orderId }).lean<any>()).status).toBe('confirming');

      await reconcile.sweep(new Date(Date.now() + 10 * 60_000)); // 시간이 흐른 뒤
      expect((await M().Payment.findOne({ tossOrderId: prep.orderId }).lean<any>()).status).toBe('done');
      expect((await t.request('GET', `/orders/${ctx.order.id}`, { token: ctx.buyer.token })).body.status).toBe('paid');
    });

    it('토스에 결제 자체가 없으면(승인 전 이탈) 대사 작업이 실패로 정리한다', async () => {
      const ctx = await makeOrder();
      const prep = (await prepare(ctx.buyer.token, ctx.order.id)).body;
      // 'confirming' 으로 남았지만 토스에는 결제가 없는 상태를 직접 만든다
      await M().Payment.updateOne({ tossOrderId: prep.orderId }, { $set: { status: 'confirming', paymentKey: key() } });
      await t.get<PaymentsReconcileService>(PaymentsReconcileService).sweep(new Date(Date.now() + 10 * 60_000));
      const p = await M().Payment.findOne({ tossOrderId: prep.orderId }).lean<any>();
      expect(p).toMatchObject({ status: 'failed', failure: { code: 'NOT_FOUND' } });
    });

    it('이미 결제된 주문에 대한 늦은 승인은 토스를 호출하지 않고 거절', async () => {
      const ctx = await makeOrder();
      await payFully(ctx);
      // 다른 탭에서 만든 두 번째 결제 시도라고 가정
      const late = await M().Payment.create({
        orderId: ctx.order.id,
        buyerId: ctx.buyer.id,
        tossOrderId: `bv_late_${Date.now()}`,
        amount: ctx.price,
      });
      const paymentKey = key();
      toss.authorize(late.tossOrderId, paymentKey, ctx.price);
      const before = toss.count('POST', '/v1/payments/confirm');
      const res = await confirm(ctx.buyer.token, { paymentKey, orderId: late.tossOrderId, amount: ctx.price });
      expect(res.status).toBe(409);
      expect(toss.count('POST', '/v1/payments/confirm')).toBe(before);
    });

    it('가상계좌: 승인 시 입금 대기, 웹훅으로 입금 완료를 받으면 토스 재조회 후 결제 완료', async () => {
      const ctx = await makeOrder();
      const prep = (await prepare(ctx.buyer.token, ctx.order.id)).body;
      const paymentKey = key();
      toss.authorize(prep.orderId, paymentKey, prep.amount);
      toss.confirmAsVirtualAccount = true;
      const res = await confirm(ctx.buyer.token, { paymentKey, orderId: prep.orderId, amount: prep.amount });
      toss.confirmAsVirtualAccount = false;

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('waiting_for_deposit');
      expect(res.body.virtualAccount).toMatchObject({ accountNumber: '1234567890' });
      expect((await t.request('GET', `/orders/${ctx.order.id}`, { token: ctx.buyer.token })).body.status).toBe('pending');
      expect((await M().Payment.findOne({ tossOrderId: prep.orderId }).lean<any>()).status).toBe('waiting');

      toss.setStatus(prep.orderId, 'DONE'); // 입금 완료
      const hook = await t.request('POST', '/payments/webhook', {
        body: { eventType: 'PAYMENT_STATUS_CHANGED', createdAt: new Date().toISOString(), data: { orderId: prep.orderId, status: 'DONE' } },
      });
      expect(hook.status).toBe(200);
      expect((await t.request('GET', `/orders/${ctx.order.id}`, { token: ctx.buyer.token })).body.status).toBe('paid');
      expect((await M().Payment.findOne({ tossOrderId: prep.orderId }).lean<any>()).status).toBe('done');
    });
  });

  describe('웹훅', () => {
    it('위조되거나 알 수 없는 웹훅은 아무것도 바꾸지 못하고 항상 200', async () => {
      const ctx = await makeOrder();
      const prep = (await prepare(ctx.buyer.token, ctx.order.id)).body; // ready 상태, 토스에는 결제 없음
      const forged = [
        { eventType: 'PAYMENT_STATUS_CHANGED', data: { orderId: prep.orderId, status: 'DONE', totalAmount: 1 } },
        { eventType: 'PAYMENT_STATUS_CHANGED', data: { orderId: 'unknown_order_id_123', status: 'DONE' } },
        { garbage: true },
        {},
        [],
        { data: { orderId: { $ne: null } } }, // 인젝션 시도
      ];
      for (const body of forged) expect((await t.request('POST', '/payments/webhook', { body })).status).toBe(200);
      expect((await t.request('GET', `/orders/${ctx.order.id}`, { token: ctx.buyer.token })).body.status).toBe('pending');
      expect((await M().Payment.findOne({ tossOrderId: prep.orderId }).lean<any>()).status).toBe('ready');
    });

    it('토스에서 취소된 결제를 웹훅으로 받으면 주문이 환불 처리된다', async () => {
      const ctx = await makeOrder();
      const { prep } = await payFully(ctx);
      toss.setStatus(prep.orderId, 'CANCELED');
      await t.request('POST', '/payments/webhook', {
        body: { eventType: 'PAYMENT_STATUS_CHANGED', data: { orderId: prep.orderId, status: 'CANCELED' } },
      });
      expect((await t.request('GET', `/orders/${ctx.order.id}`, { token: ctx.buyer.token })).body.status).toBe('refunded');
      expect((await M().Payment.findOne({ tossOrderId: prep.orderId }).lean<any>()).status).toBe('canceled');
    });
  });

  describe('환불', () => {
    it('구매자는 발송 전에 직접 취소할 수 있고, 토스에 취소가 전달되며 양쪽에 알림이 간다', async () => {
      const ctx = await makeOrder(18_000);
      const { paymentKey } = await payFully(ctx);

      expect((await t.request('POST', `/orders/${ctx.order.id}/refund`, { token: ctx.seller.token, body: { reason: '판매자가 시도' } })).status).toBe(404);
      const res = await t.request('POST', `/orders/${ctx.order.id}/refund`, { token: ctx.buyer.token, body: { reason: '단순 변심' } });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('refunded');

      const cancel = toss.last('POST', `/v1/payments/${paymentKey}/cancel`)!;
      expect(cancel.body).toEqual({ cancelReason: '단순 변심' });
      expect(String(cancel.headers['idempotency-key'])).toMatch(/^cancel-/);
      expect((await M().Payment.findOne({ orderId: ctx.order.id }).lean<any>()).status).toBe('canceled');
      for (const who of [ctx.buyer, ctx.seller]) {
        const inbox = await t.request('GET', '/me/notifications', { token: who.token });
        expect(inbox.body.items.map((n: any) => n.type)).toContain('refunded');
      }
      // 두 번 환불할 수는 없다
      expect((await t.request('POST', `/orders/${ctx.order.id}/refund`, { token: ctx.buyer.token, body: { reason: '또 환불할래요' } })).status).toBe(409);
    });

    it('발송된 뒤에는 구매자 직접 취소는 막히고 관리자만 환불할 수 있다', async () => {
      const ctx = await makeOrder();
      await payFully(ctx);
      expect((await t.request('POST', `/orders/${ctx.order.id}/ship`, { token: ctx.seller.token })).status).toBe(200);

      expect((await t.request('POST', `/orders/${ctx.order.id}/refund`, { token: ctx.buyer.token, body: { reason: '이제 싫어요' } })).status).toBe(409);

      // 일반 사용자는 관리자 경로를 쓸 수 없다
      expect((await t.request('POST', `/admin/orders/${ctx.order.id}/refund`, { token: ctx.buyer.token, body: { reason: '관리자인 척' } })).status).toBe(403);
      // (DB에서 직접 승격하면 인증 캐시 때문에 최대 5초 늦게 반영되므로, 첫 요청 전에 승격한다)
      const admin = await t.register('padmin');
      await M().User.updateOne({ _id: admin.id }, { $set: { role: 'admin' } });
      const refund = await t.request('POST', `/admin/orders/${ctx.order.id}/refund`, { token: admin.token, body: { reason: '분쟁 조정' } });
      expect(refund.status).toBe(200);
      expect((await t.request('GET', `/orders/${ctx.order.id}`, { token: ctx.buyer.token })).body.status).toBe('refunded');
      // 관리자 주문 목록에서 환불 건을 찾을 수 있다
      const list = await t.request('GET', '/admin/orders?status=refunded', { token: admin.token });
      expect(list.body.items.map((o: any) => o.id)).toContain(ctx.order.id);
      expect((await t.request('GET', '/admin/orders', { token: ctx.buyer.token })).status).toBe(403);
    });

    it('토스에서 이미 취소된 결제를 환불하려 해도 우리 상태는 맞춰진다', async () => {
      const ctx = await makeOrder();
      const { prep } = await payFully(ctx);
      toss.setStatus(prep.orderId, 'CANCELED'); // 토스 쪽에서는 이미 취소됨 (웹훅은 아직 못 받음)
      const res = await t.request('POST', `/orders/${ctx.order.id}/refund`, { token: ctx.buyer.token, body: { reason: '환불해 주세요' } });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('refunded');
    });

    it('결제 전 주문은 환불할 수 없다', async () => {
      const ctx = await makeOrder();
      expect((await t.request('POST', `/orders/${ctx.order.id}/refund`, { token: ctx.buyer.token, body: { reason: '취소할래요' } })).status).toBe(409);
    });
  });

  describe('주문 상태 전이는 결제 이후에만', () => {
    it('결제 전에는 발송/수령 확인이 안 되고, /orders/:id/pay 같은 우회 경로는 없다', async () => {
      const ctx = await makeOrder();
      expect((await t.request('POST', `/orders/${ctx.order.id}/ship`, { token: ctx.seller.token })).status).toBe(409);
      expect((await t.request('POST', `/orders/${ctx.order.id}/pay`, { token: ctx.buyer.token })).status).toBe(404);
      expect((await t.request('GET', `/orders/${ctx.order.id}`, { token: ctx.buyer.token })).body.status).toBe('pending');
    });
  });
});

describe('결제 모드', () => {
  it('운영에서 토스 키가 없으면 결제를 막는다 (모의 결제로 공짜 결제 완료가 되지 않도록)', async () => {
    const previous = process.env.NODE_ENV;
    const t = await startApp({ NODE_ENV: 'production' });
    try {
      const seller = await t.register('modeseller');
      const buyer = await t.register('modebuyer');
      const a = (
        await t.request('POST', '/auctions', {
          token: seller.token,
          body: { title: 'x', startPrice: 1000, endsAt: inFuture(3600_000) },
        })
      ).body;
      await t.request('POST', `/auctions/${a.id}/bids`, { token: buyer.token, body: { amount: 1000 } });
      await t.connection.models.Auction.updateOne({ _id: a.id }, { $set: { endsAt: new Date(Date.now() - 1000) } });
      await t.get<SettlementService>(SettlementService).sweep();
      const order = (await t.request('GET', '/me/orders', { token: buyer.token })).body[0];

      expect((await t.request('POST', `/orders/${order.id}/payment`, { token: buyer.token })).status).toBe(503);
      expect(
        (await t.request('POST', '/payments/confirm', { token: buyer.token, body: { paymentKey: 'mock_x', orderId: 'bv_whatever_123', amount: 1000 } })).status,
      ).toBe(503);
      expect((await t.request('GET', `/orders/${order.id}`, { token: buyer.token })).body.status).toBe('pending');
    } finally {
      process.env.NODE_ENV = previous;
      await t.close();
    }
  }, 60_000);
});
