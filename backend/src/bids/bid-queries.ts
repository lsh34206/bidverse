import type { Types } from 'mongoose';
import { MAX_EXTENSIONS, SNIPING_WINDOW_MS } from '../auctions/auction.constants.js';

type Id = Types.ObjectId | string;

/**
 * 입찰 가능 조건. 첫 입찰은 시작가 이상, 이후는 현재가 + 최소 입찰 단위 이상이어야 한다.
 * 조건 검사와 갱신을 한 번의 원자 연산으로 묶는 데 쓰인다.
 */
export function buildBidFilter(auctionId: Id, userId: Id, amount: number, now: Date) {
  return {
    _id: auctionId,
    suspended: { $ne: true },
    startsAt: { $lte: now },
    endsAt: { $gt: now },
    sellerId: { $ne: userId },
    highestBidderId: { $ne: userId },
    $or: [
      { bidCount: 0, currentPrice: { $lte: amount } },
      {
        bidCount: { $gt: 0 },
        $expr: { $lte: [{ $add: ['$currentPrice', '$minIncrement'] }, amount] },
      },
    ],
  };
}

/** 종료 시각이 연장 구간 안에 있고 연장 횟수가 남아 있는지 판단하는 앱 쪽 계산 (파이프라인과 동일한 규칙) */
export function willExtend(endsAt: Date, extensionCount: number | undefined, now: Date): boolean {
  return (
    endsAt.getTime() < now.getTime() + SNIPING_WINDOW_MS &&
    (extensionCount ?? 0) < MAX_EXTENSIONS
  );
}

/**
 * 입찰 반영 업데이트 (집계 파이프라인 형태).
 * 종료 임박 시 endsAt을 `now + 연장 구간`으로 늦추고 연장 횟수를 올린다.
 * 파이프라인 안의 값은 스키마 캐스팅을 거치지 않으므로 userId는 ObjectId로 넘겨야 한다.
 */
export function buildBidUpdate(userId: Id, amount: number, now: Date) {
  const edge = new Date(now.getTime() + SNIPING_WINDOW_MS);
  const extensions = { $ifNull: ['$extensionCount', 0] };
  const extend = {
    // 남은 시간이 연장 구간보다 짧을 때만 늦춘다. 정확히 구간 길이만큼 남았다면 늘어날 시간이 없다.
    $and: [{ $lt: ['$endsAt', edge] }, { $lt: [extensions, MAX_EXTENSIONS] }],
  };
  return [
    {
      $set: {
        currentPrice: amount,
        highestBidderId: userId,
        bidCount: { $add: ['$bidCount', 1] },
        extensionCount: { $cond: [extend, { $add: [extensions, 1] }, extensions] },
        endsAt: { $cond: [extend, edge, '$endsAt'] },
      },
    },
  ];
}

/** 즉시구매: 즉시구매가로 낙찰자를 확정하고 그 순간 경매를 종료한다. */
export function buildBuyNowFilter(auctionId: Id, userId: Id, now: Date) {
  return {
    _id: auctionId,
    suspended: { $ne: true },
    startsAt: { $lte: now },
    endsAt: { $gt: now },
    sellerId: { $ne: userId },
    buyNowPrice: { $ne: null, $exists: true },
    $expr: { $lt: ['$currentPrice', '$buyNowPrice'] },
  };
}

export function buildBuyNowUpdate(userId: Id, now: Date) {
  return [
    {
      $set: {
        currentPrice: '$buyNowPrice',
        highestBidderId: userId,
        bidCount: { $add: ['$bidCount', 1] },
        endsAt: now,
      },
    },
  ];
}
