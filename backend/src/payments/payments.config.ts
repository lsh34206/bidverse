import { createHmac } from 'node:crypto';

export type PaymentMode = 'toss' | 'mock' | 'off';

export interface PaymentsConfig {
  mode: PaymentMode;
  /** 결제위젯 연동 클라이언트 키 (test_gck_ / live_gck_). 브라우저에 내려가도 되는 공개 키. */
  clientKey?: string;
  /** 시크릿 키 (test_gsk_ / live_gsk_). 서버에만 둔다. */
  secretKey?: string;
  apiBase: string;
  /** customerKey 해시용 비밀값 */
  customerKeySecret: string;
}

type Env = Record<string, string | undefined>;

/**
 * 결제 모드 결정:
 *  - TOSS_CLIENT_KEY + TOSS_SECRET_KEY 가 모두 있으면 'toss' (실제 토스 호출)
 *  - 없으면 개발 환경에서만 'mock' (가짜 결제). PAYMENT_MOCK=false 로 끌 수 있다.
 *  - 운영(NODE_ENV=production)에서 키가 없으면 'off' — 결제를 아예 막는다.
 *    (키 누락 상태에서 모의 결제가 열려 공짜로 '결제 완료'가 되는 사고를 막기 위함)
 */
export function resolvePaymentsConfig(env: Env): PaymentsConfig {
  const clientKey = env.TOSS_CLIENT_KEY?.trim() || undefined;
  const secretKey = env.TOSS_SECRET_KEY?.trim() || undefined;
  const base = {
    clientKey,
    secretKey,
    apiBase: (env.TOSS_API_BASE?.trim() || 'https://api.tosspayments.com').replace(/\/+$/, ''),
    customerKeySecret: env.JWT_SECRET ?? 'dev-only',
  };

  if (clientKey && secretKey) return { ...base, mode: 'toss' };
  if (env.NODE_ENV !== 'production' && env.PAYMENT_MOCK !== 'false') return { ...base, mode: 'mock' };
  return { ...base, mode: 'off' };
}

/**
 * 토스 customerKey: 구매자를 식별하는 값이라 추측할 수 없어야 한다 (이메일, 순번 ID 금지).
 * 사용자 id를 서버 비밀값으로 HMAC 해서 만든 고정값을 쓴다. 2~50자, 영문/숫자/-/_ 만 사용.
 */
export function customerKeyFor(userId: string, secret: string): string {
  return `bv_${createHmac('sha256', secret).update(userId).digest('hex').slice(0, 32)}`;
}
