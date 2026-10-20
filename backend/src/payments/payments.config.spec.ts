import { customerKeyFor, resolvePaymentsConfig } from './payments.config.js';

describe('결제 모드 결정 (보안상 중요: 운영에서 모의 결제가 열리면 안 된다)', () => {
  const keys = { TOSS_CLIENT_KEY: 'test_gck_x', TOSS_SECRET_KEY: 'test_gsk_x' };

  it('키가 둘 다 있으면 어떤 환경이든 toss', () => {
    expect(resolvePaymentsConfig({ ...keys }).mode).toBe('toss');
    expect(resolvePaymentsConfig({ ...keys, NODE_ENV: 'production' }).mode).toBe('toss');
  });

  it('키가 없는 개발 환경에서는 mock', () => {
    expect(resolvePaymentsConfig({}).mode).toBe('mock');
    expect(resolvePaymentsConfig({ NODE_ENV: 'development' }).mode).toBe('mock');
    expect(resolvePaymentsConfig({ NODE_ENV: 'test' }).mode).toBe('mock');
  });

  it('키가 없는 운영 환경에서는 mock 이 아니라 off (결제 차단)', () => {
    expect(resolvePaymentsConfig({ NODE_ENV: 'production' }).mode).toBe('off');
  });

  it('PAYMENT_MOCK=false 면 개발 환경에서도 mock 을 끈다', () => {
    expect(resolvePaymentsConfig({ PAYMENT_MOCK: 'false' }).mode).toBe('off');
  });

  it('PAYMENT_MOCK=true 를 줘도 운영에서는 mock 이 열리지 않는다', () => {
    expect(resolvePaymentsConfig({ NODE_ENV: 'production', PAYMENT_MOCK: 'true' }).mode).toBe('off');
  });

  it('키가 하나만 있으면 toss 로 보지 않는다 (설정 누락)', () => {
    expect(resolvePaymentsConfig({ TOSS_CLIENT_KEY: 'test_gck_x', NODE_ENV: 'production' }).mode).toBe('off');
    expect(resolvePaymentsConfig({ TOSS_SECRET_KEY: 'test_gsk_x', NODE_ENV: 'production' }).mode).toBe('off');
    expect(resolvePaymentsConfig({ TOSS_CLIENT_KEY: '  ', TOSS_SECRET_KEY: 'test_gsk_x', NODE_ENV: 'production' }).mode).toBe('off');
  });

  it('API 주소는 기본값이 토스 공식 주소이고 끝의 슬래시는 제거된다', () => {
    expect(resolvePaymentsConfig({}).apiBase).toBe('https://api.tosspayments.com');
    expect(resolvePaymentsConfig({ TOSS_API_BASE: 'http://localhost:9999///' }).apiBase).toBe('http://localhost:9999');
  });
});

describe('customerKey', () => {
  it('같은 사용자에게는 항상 같은 값, 다른 사용자/다른 비밀값이면 다른 값', () => {
    const a = customerKeyFor('user-1', 'secret');
    expect(customerKeyFor('user-1', 'secret')).toBe(a);
    expect(customerKeyFor('user-2', 'secret')).not.toBe(a);
    expect(customerKeyFor('user-1', 'other-secret')).not.toBe(a);
  });

  it('토스 규칙(2~50자, 영문/숫자/-/_)을 지키고 사용자 id 를 드러내지 않는다', () => {
    const key = customerKeyFor('6ad5a3f1be8358b10f9d3c9c', 'secret');
    expect(key).toMatch(/^[A-Za-z0-9_-]{2,50}$/);
    expect(key).not.toContain('6ad5a3f1be8358b10f9d3c9c');
  });
});
