import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

interface FakePayment {
  paymentKey: string;
  orderId: string;
  status: string;
  totalAmount: number;
  method: string;
  approvedAt: string;
  receipt: { url: string };
  virtualAccount?: { bankCode: string; accountNumber: string };
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: any;
}

/**
 * 토스페이먼츠 API를 흉내 내는 로컬 서버. 실제 키 없이 결제 흐름 전체를 검증하려고 쓴다.
 *  - authorize(): 구매자가 결제위젯에서 인증을 마친 상태(= 토스에 결제 세션이 생긴 상태)를 만든다
 *  - 승인 API는 세션이 있어야 하고, 금액이 세션과 같아야 한다
 *  - Idempotency-Key 가 같으면 처음 응답을 그대로 돌려준다 (토스와 같은 동작)
 */
export class FakeToss {
  private server!: Server;
  readonly secretKey = 'test_gsk_fake_secret_for_e2e';
  baseUrl = '';
  requests: RecordedRequest[] = [];

  private sessions = new Map<string, { paymentKey: string; amount: number }>();
  private payments = new Map<string, FakePayment>(); // orderId -> payment
  private idempotent = new Map<string, { status: number; body: unknown }>();

  /** 다음 승인 요청을 이 응답으로 거절한다 */
  failNextConfirm?: { status: number; code: string; message: string };
  /** 다음 승인 요청은 처리(승인)는 하되, 응답을 보내기 전에 연결을 끊는다 (승인됐는데 응답이 유실되는 최악의 경우) */
  dropNextConfirmResponse = false;
  /** 승인 결과를 가상계좌 입금 대기로 응답한다 */
  confirmAsVirtualAccount = false;

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : undefined;
      const path = req.url ?? '';
      this.requests.push({ method: req.method ?? '', path, headers: req.headers, body });

      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      const expectedAuth = `Basic ${Buffer.from(`${this.secretKey}:`).toString('base64')}`;
      if (req.headers.authorization !== expectedAuth) {
        return send(401, { code: 'UNAUTHORIZED_KEY', message: '인증되지 않은 시크릿 키 혹은 클라이언트 키 입니다.' });
      }

      if (req.method === 'POST' && path === '/v1/payments/confirm') return this.confirm(req, body, send, res);

      const cancel = path.match(/^\/v1\/payments\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && cancel) {
        const paymentKey = decodeURIComponent(cancel[1]);
        const found = [...this.payments.values()].find((p) => p.paymentKey === paymentKey);
        if (!found) return send(404, { code: 'NOT_FOUND_PAYMENT', message: '존재하지 않는 결제 정보 입니다.' });
        if (found.status === 'CANCELED') return send(400, { code: 'ALREADY_CANCELED_PAYMENT', message: '이미 취소된 결제 입니다.' });
        if (!body?.cancelReason) return send(400, { code: 'INVALID_REQUEST', message: 'cancelReason 필수' });
        found.status = 'CANCELED';
        return send(200, found);
      }

      const byOrder = path.match(/^\/v1\/payments\/orders\/([^/]+)$/);
      if (req.method === 'GET' && byOrder) {
        const found = this.payments.get(decodeURIComponent(byOrder[1]));
        return found
          ? send(200, found)
          : send(404, { code: 'NOT_FOUND_PAYMENT', message: '존재하지 않는 결제 정보 입니다.' });
      }
      send(404, { code: 'NOT_FOUND', message: 'unknown route' });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** 구매자가 결제창에서 인증을 마친 상태를 만든다 */
  authorize(orderId: string, paymentKey: string, amount: number): void {
    this.sessions.set(orderId, { paymentKey, amount });
  }

  /** 토스 쪽 결제 상태를 직접 바꾼다 (입금 완료, 외부 취소 등을 흉내) */
  setStatus(orderId: string, status: string): void {
    const p = this.payments.get(orderId);
    if (!p) throw new Error(`fake toss: no payment for ${orderId}`);
    p.status = status;
  }

  count(method: string, pathPart: string): number {
    return this.requests.filter((r) => r.method === method && r.path.includes(pathPart)).length;
  }

  last(method: string, pathPart: string): RecordedRequest | undefined {
    return [...this.requests].reverse().find((r) => r.method === method && r.path.includes(pathPart));
  }

  private confirm(
    req: IncomingMessage,
    body: { paymentKey: string; orderId: string; amount: number },
    send: (status: number, payload: unknown) => void,
    res: import('node:http').ServerResponse,
  ) {
    const idem = req.headers['idempotency-key'] as string | undefined;
    if (idem && this.idempotent.has(idem)) {
      const stored = this.idempotent.get(idem)!;
      return send(stored.status, stored.body);
    }
    const respond = (status: number, payload: unknown) => {
      if (idem) this.idempotent.set(idem, { status, body: payload });
      if (this.dropNextConfirmResponse && status === 200) {
        this.dropNextConfirmResponse = false;
        res.socket?.destroy(); // 승인은 끝났지만 응답이 유실됨
        return;
      }
      send(status, payload);
    };

    if (this.failNextConfirm) {
      const f = this.failNextConfirm;
      this.failNextConfirm = undefined;
      return respond(f.status, { code: f.code, message: f.message });
    }
    const session = this.sessions.get(body.orderId);
    if (!session || session.paymentKey !== body.paymentKey) {
      return respond(404, { code: 'NOT_FOUND_PAYMENT_SESSION', message: '결제 시간이 만료되어 결제 진행 데이터가 존재하지 않습니다.' });
    }
    if (session.amount !== body.amount) {
      return respond(400, { code: 'INVALID_REQUEST', message: '결제 금액이 일치하지 않습니다.' });
    }
    const existing = this.payments.get(body.orderId);
    if (existing && existing.status === 'DONE') {
      return respond(400, { code: 'ALREADY_PROCESSED_PAYMENT', message: '이미 처리된 결제 입니다.' });
    }
    const payment: FakePayment = {
      paymentKey: body.paymentKey,
      orderId: body.orderId,
      status: this.confirmAsVirtualAccount ? 'WAITING_FOR_DEPOSIT' : 'DONE',
      totalAmount: body.amount,
      method: this.confirmAsVirtualAccount ? '가상계좌' : '카드',
      approvedAt: new Date().toISOString(),
      receipt: { url: `https://receipt.example/${body.paymentKey}` },
      ...(this.confirmAsVirtualAccount ? { virtualAccount: { bankCode: '20', accountNumber: '1234567890' } } : {}),
    };
    this.payments.set(body.orderId, payment);
    respond(200, payment);
  }
}
