import { Aggregator, Query } from 'mingo';
import { MAX_EXTENSIONS, SNIPING_WINDOW_MS } from '../auctions/auction.constants.js';
import {
  buildBidFilter,
  buildBidUpdate,
  buildBuyNowFilter,
  buildBuyNowUpdate,
  willExtend,
} from './bid-queries.js';

/**
 * 실제 MongoDB 없이 쿼리/파이프라인 표현식의 의미를 확인하기 위해 mingo(MongoDB 질의 엔진의 JS 구현)로 돌려 본다.
 * 연산자 구현이 MongoDB와 완전히 같지는 않으므로, 실DB 검증을 대체하지는 않는다.
 */
const MIN = 60 * 1000;
const now = new Date('2026-01-01T12:00:00Z');
const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);

const auction = (over: Record<string, unknown> = {}) => ({
  _id: 'a1',
  sellerId: 'seller',
  startsAt: at(-60 * MIN),
  endsAt: at(60 * MIN),
  startPrice: 1000,
  currentPrice: 1000,
  minIncrement: 500,
  bidCount: 0,
  extensionCount: 0,
  buyNowPrice: null as number | null,
  highestBidderId: undefined as string | undefined,
  ...over,
});

const accepts = (doc: object, amount: number, userId = 'u1') =>
  new Query(buildBidFilter('a1', userId, amount, now)).test(doc);

describe('입찰 필터', () => {
  it('첫 입찰은 시작가 이상이면 통과한다', () => {
    expect(accepts(auction(), 1000)).toBe(true);
    expect(accepts(auction(), 999)).toBe(false);
  });

  it('이후 입찰은 현재가 + 최소 단위 이상이어야 한다', () => {
    const doc = auction({ bidCount: 2, currentPrice: 3000, highestBidderId: 'other' });
    expect(accepts(doc, 3500)).toBe(true);
    expect(accepts(doc, 3499)).toBe(false);
    expect(accepts(doc, 3000)).toBe(false);
  });

  it('판매자와 현재 최고가 입찰자는 입찰할 수 없다', () => {
    expect(accepts(auction(), 1000, 'seller')).toBe(false);
    expect(accepts(auction({ bidCount: 1, highestBidderId: 'u1' }), 5000, 'u1')).toBe(false);
  });

  it('관리자가 중지한 경매에는 입찰할 수 없다 (필드가 없는 기존 문서는 통과)', () => {
    expect(accepts(auction({ suspended: true }), 1000)).toBe(false);
    expect(accepts(auction({ suspended: false }), 1000)).toBe(true);
    expect(accepts(auction(), 1000)).toBe(true);
  });

  it('시작 전이거나 종료된 경매에는 입찰할 수 없다', () => {
    expect(accepts(auction({ startsAt: at(MIN) }), 1000)).toBe(false);
    expect(accepts(auction({ endsAt: at(-1) }), 1000)).toBe(false);
    expect(accepts(auction({ endsAt: now }), 1000)).toBe(false);
  });
});

describe('입찰 업데이트 파이프라인 (스나이핑 방지)', () => {
  const apply = (doc: object, amount = 2000) =>
    new Aggregator(buildBidUpdate('u1', amount, now)).run([doc])[0] as ReturnType<typeof auction>;

  it('가격, 최고가 입찰자, 입찰 수를 갱신한다', () => {
    const out = apply(auction({ bidCount: 3 }), 2500);
    expect(out).toMatchObject({ currentPrice: 2500, highestBidderId: 'u1', bidCount: 4 });
  });

  it('마감이 넉넉하면 종료 시각을 그대로 둔다', () => {
    const doc = auction({ endsAt: at(SNIPING_WINDOW_MS + MIN) });
    const out = apply(doc);
    expect(out.endsAt).toEqual(doc.endsAt);
    expect(out.extensionCount).toBe(0);
  });

  it('마감 연장 구간 안이면 종료 시각을 now + 구간으로 늦추고 횟수를 올린다', () => {
    const out = apply(auction({ endsAt: at(MIN), extensionCount: 2 }));
    expect(out.endsAt).toEqual(at(SNIPING_WINDOW_MS));
    expect(out.extensionCount).toBe(3);
  });

  it('정확히 5분 남았을 때는 늘어날 시간이 없으므로 연장하지 않는다', () => {
    const out = apply(auction({ endsAt: at(SNIPING_WINDOW_MS) }));
    expect(out.extensionCount).toBe(0);
    expect(out.endsAt).toEqual(at(SNIPING_WINDOW_MS));
  });

  it('5분보다 1ms라도 짧게 남으면 연장한다', () => {
    const out = apply(auction({ endsAt: at(SNIPING_WINDOW_MS - 1) }));
    expect(out.extensionCount).toBe(1);
    expect(out.endsAt).toEqual(at(SNIPING_WINDOW_MS));
  });

  it('연장 횟수 상한에 도달하면 더 연장하지 않는다', () => {
    const doc = auction({ endsAt: at(MIN), extensionCount: MAX_EXTENSIONS });
    const out = apply(doc);
    expect(out.endsAt).toEqual(doc.endsAt);
    expect(out.extensionCount).toBe(MAX_EXTENSIONS);
  });

  it('extensionCount 필드가 없는 기존 문서도 처리한다', () => {
    const { extensionCount: _omit, ...legacy } = auction({ endsAt: at(MIN) });
    expect((apply(legacy) as { extensionCount: number }).extensionCount).toBe(1);
  });

  it('앱 쪽 willExtend가 파이프라인 결과와 일치한다', () => {
    const cases = [
      { endsAt: at(MIN), extensionCount: 0 },
      { endsAt: at(SNIPING_WINDOW_MS - 1), extensionCount: 0 },
      { endsAt: at(SNIPING_WINDOW_MS), extensionCount: 0 },
      { endsAt: at(SNIPING_WINDOW_MS + 1), extensionCount: 0 },
      { endsAt: at(MIN), extensionCount: MAX_EXTENSIONS },
      { endsAt: at(MIN), extensionCount: MAX_EXTENSIONS - 1 },
    ];
    for (const c of cases) {
      const out = apply(auction(c));
      const extendedByPipeline = out.endsAt.getTime() !== c.endsAt.getTime();
      expect(willExtend(c.endsAt, c.extensionCount, now)).toBe(extendedByPipeline);
    }
  });
});

describe('즉시구매', () => {
  const buyable = (doc: object, userId = 'u1') =>
    new Query(buildBuyNowFilter('a1', userId, now)).test(doc);

  it('즉시구매가가 있고 현재가가 그보다 낮을 때만 가능하다', () => {
    expect(buyable(auction({ buyNowPrice: 10000, currentPrice: 9500 }))).toBe(true);
    expect(buyable(auction({ buyNowPrice: 10000, currentPrice: 10000 }))).toBe(false);
    expect(buyable(auction({ buyNowPrice: null }))).toBe(false);
  });

  it('즉시구매가 필드가 아예 없는 경매는 불가', () => {
    const { buyNowPrice: _omit, ...doc } = auction();
    expect(buyable(doc)).toBe(false);
  });

  it('중지된 경매는 즉시구매도 불가', () => {
    expect(buyable(auction({ buyNowPrice: 10000, suspended: true }))).toBe(false);
  });

  it('판매자나 종료된 경매는 불가', () => {
    expect(buyable(auction({ buyNowPrice: 10000 }), 'seller')).toBe(false);
    expect(buyable(auction({ buyNowPrice: 10000, endsAt: at(-1) }))).toBe(false);
  });

  it('성공하면 즉시구매가로 낙찰자를 정하고 그 순간 종료한다', () => {
    const out = new Aggregator(buildBuyNowUpdate('u1', now)).run([
      auction({ buyNowPrice: 10000, bidCount: 2, currentPrice: 3000 }),
    ])[0] as ReturnType<typeof auction>;
    expect(out).toMatchObject({ currentPrice: 10000, highestBidderId: 'u1', bidCount: 3 });
    expect(out.endsAt).toEqual(now);
  });
});
