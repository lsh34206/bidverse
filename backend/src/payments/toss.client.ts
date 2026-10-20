import { Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

/** 토스 Payment 객체 중 우리가 쓰는 필드만 */
export interface TossPayment {
  paymentKey: string;
  orderId: string;
  status:
    | 'READY'
    | 'IN_PROGRESS'
    | 'WAITING_FOR_DEPOSIT'
    | 'DONE'
    | 'CANCELED'
    | 'PARTIAL_CANCELED'
    | 'ABORTED'
    | 'EXPIRED';
  totalAmount: number;
  method?: string;
  approvedAt?: string;
  receipt?: { url?: string };
  virtualAccount?: { bankCode?: string; accountNumber?: string; dueDate?: string };
}

/** 토스가 4xx/5xx와 함께 돌려준 에러 ({ code, message }) */
export class TossApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 응답을 받지 못한 경우 (타임아웃, 네트워크 단절). 결제가 승인됐는지 알 수 없는 상태다. */
export class TossNetworkError extends Error {}

export abstract class TossClient {
  abstract confirm(
    body: { paymentKey: string; orderId: string; amount: number },
    idempotencyKey: string,
  ): Promise<TossPayment>;
  abstract cancel(paymentKey: string, cancelReason: string, idempotencyKey: string): Promise<TossPayment>;
  abstract getByOrderId(orderId: string): Promise<TossPayment | null>;
}

const REQUEST_TIMEOUT_MS = 20_000;

export class HttpTossClient extends TossClient {
  private readonly logger = new Logger(HttpTossClient.name);
  private readonly auth: string;

  constructor(
    secretKey: string,
    private readonly baseUrl: string,
  ) {
    super();
    // 시크릿 키 뒤에 콜론을 붙여 base64 (비밀번호 자리는 비움). 콜론이 빠지면 인증이 실패한다.
    this.auth = `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`;
  }

  confirm(body: { paymentKey: string; orderId: string; amount: number }, idempotencyKey: string) {
    return this.request('POST', '/v1/payments/confirm', body, idempotencyKey);
  }

  cancel(paymentKey: string, cancelReason: string, idempotencyKey: string) {
    return this.request('POST', `/v1/payments/${encodeURIComponent(paymentKey)}/cancel`, { cancelReason }, idempotencyKey);
  }

  async getByOrderId(orderId: string): Promise<TossPayment | null> {
    try {
      return await this.request('GET', `/v1/payments/orders/${encodeURIComponent(orderId)}`);
    } catch (err) {
      // 결제창만 열고 인증하지 않았다면 토스에 결제 자체가 없다.
      if (err instanceof TossApiError && err.status === 404) return null;
      throw err;
    }
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<TossPayment> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: this.auth,
          'Content-Type': 'application/json',
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.error(`toss ${method} ${path} 응답 없음: ${(err as Error).message}`);
      throw new TossNetworkError((err as Error).message);
    }

    const data = (await res.json().catch(() => null)) as
      | (TossPayment & { code?: string; message?: string })
      | null;
    if (!res.ok) {
      const code = data?.code ?? 'UNKNOWN';
      const message = data?.message ?? `HTTP ${res.status}`;
      this.logger.warn(`toss ${method} ${path} -> ${res.status} ${code}`);
      throw new TossApiError(res.status, code, message);
    }
    return data as TossPayment;
  }
}

/**
 * 키 없이 개발할 때 쓰는 가짜 토스. 실제 결제는 일어나지 않는다.
 * 운영(NODE_ENV=production)에서는 절대 선택되지 않는다 (payments.config 참고).
 */
export class MockTossClient extends TossClient {
  private readonly payments = new Map<string, TossPayment>();

  async confirm(body: { paymentKey: string; orderId: string; amount: number }) {
    const payment: TossPayment = {
      paymentKey: body.paymentKey,
      orderId: body.orderId,
      status: 'DONE',
      totalAmount: body.amount,
      method: '모의결제',
      approvedAt: new Date().toISOString(),
      receipt: { url: `mock://receipt/${randomBytes(4).toString('hex')}` },
    };
    this.payments.set(body.orderId, payment);
    return payment;
  }

  async cancel(paymentKey: string) {
    const found = [...this.payments.values()].find((p) => p.paymentKey === paymentKey);
    if (!found) throw new TossApiError(404, 'NOT_FOUND_PAYMENT', '존재하지 않는 결제입니다');
    if (found.status === 'CANCELED') throw new TossApiError(400, 'ALREADY_CANCELED_PAYMENT', '이미 취소된 결제입니다');
    found.status = 'CANCELED';
    return found;
  }

  async getByOrderId(orderId: string) {
    return this.payments.get(orderId) ?? null;
  }
}
