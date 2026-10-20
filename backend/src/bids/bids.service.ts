import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model, Types } from 'mongoose';
import { SNIPING_WINDOW_MS } from '../auctions/auction.constants.js';
import { Auction } from '../auctions/auction.schema.js';
import type { AuthUser } from '../auth/jwt-auth.guard.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { SettlementService } from '../settlement/settlement.service.js';
import {
  buildBidFilter,
  buildBidUpdate,
  buildBuyNowFilter,
  buildBuyNowUpdate,
  willExtend,
} from './bid-queries.js';
import { Bid, BidDocument } from './bid.schema.js';
import { BidsGateway } from './bids.gateway.js';

export interface BidView {
  id: string;
  amount: number;
  bidder: string;
  createdAt: Date;
}

export interface PlaceBidResult {
  bid: BidView;
  currentPrice: number;
  bidCount: number;
  minNextBid: number;
  highestBidderId: string;
  endsAt: Date;
  extended: boolean;
}

const maskNickname = (nickname: string) => `${[...nickname][0] ?? '?'}***`;
const won = (n: number) => `${n.toLocaleString('ko-KR')}원`;

@Injectable()
export class BidsService {
  private readonly logger = new Logger(BidsService.name);

  constructor(
    @InjectModel(Auction.name) private readonly auctions: Model<Auction>,
    @InjectModel(Bid.name) private readonly bids: Model<Bid>,
    private readonly gateway: BidsGateway,
    private readonly settlement: SettlementService,
    private readonly notifications: NotificationsService,
  ) {}

  async place(user: AuthUser, auctionId: string, amount: number): Promise<PlaceBidResult> {
    this.assertValidId(auctionId);

    const now = new Date();
    // 조건 검사와 갱신(스나이핑 방지 연장 포함)을 단일 문서 연산 하나로 처리해서
    // 동시 입찰에서도 가격이 역전되거나 종료 시각이 어긋나지 않는다.
    const before = await this.auctions
      .findOneAndUpdate(
        buildBidFilter(auctionId, user.id, amount, now),
        buildBidUpdate(new Types.ObjectId(user.id), amount, now),
        { returnDocument: 'before', updatePipeline: true },
      )
      .exec();

    if (!before) throw await this.explainRejection(auctionId, user.id, amount, now);

    const extended = willExtend(before.endsAt, before.extensionCount, now);
    const result = await this.finish({
      auctionId,
      userId: user.id,
      nickname: user.nickname,
      amount,
      bidCount: before.bidCount + 1,
      minNextBid: amount + before.minIncrement,
      endsAt: extended ? new Date(now.getTime() + SNIPING_WINDOW_MS) : before.endsAt,
      extended,
      now,
      before,
    });
    return result;
  }

  /** 즉시구매가로 낙찰자를 확정하고 경매를 그 자리에서 끝낸다. */
  async buyNow(user: AuthUser, auctionId: string): Promise<PlaceBidResult> {
    this.assertValidId(auctionId);

    const now = new Date();
    const before = await this.auctions
      .findOneAndUpdate(
        buildBuyNowFilter(auctionId, user.id, now),
        buildBuyNowUpdate(new Types.ObjectId(user.id), now),
        { returnDocument: 'before', updatePipeline: true },
      )
      .exec();
    if (!before || before.buyNowPrice == null) {
      throw await this.explainBuyNowRejection(auctionId, user.id, now);
    }

    const amount = before.buyNowPrice;
    const result = await this.finish({
      auctionId,
      userId: user.id,
      nickname: user.nickname,
      amount,
      bidCount: before.bidCount + 1,
      minNextBid: amount,
      endsAt: now,
      extended: false,
      now,
      before,
    });

    // 바로 정산해서 주문까지 만든다. 실패해도 정산 스케줄러가 곧 이어받는다.
    await this.settlement.settle(auctionId).catch((err: unknown) => {
      this.logger.error(
        `immediate settlement failed auction=${auctionId}`,
        err instanceof Error ? err.stack : String(err),
      );
    });
    return result;
  }

  async list(auctionId: string, limit = 30): Promise<BidView[]> {
    this.assertValidId(auctionId);
    const docs = await this.bids
      .find({ auctionId })
      .sort({ createdAt: -1, _id: -1 })
      .limit(Math.min(Math.max(limit, 1), 100))
      .exec();
    // 닉네임은 입찰 기록에 함께 저장해 두어서 목록 조회에 사용자 컬렉션 조회가 필요 없다.
    return docs.map((d) => ({
      id: d.id,
      amount: d.amount,
      bidder: d.bidderNickname ? maskNickname(d.bidderNickname) : '(알 수 없음)',
      createdAt: (d as unknown as { createdAt: Date }).createdAt,
    }));
  }

  /** 입찰이 반영된 뒤의 공통 후처리: 기록 저장, 실시간 브로드캐스트, 밀려난 입찰자 알림. */
  private async finish(p: {
    auctionId: string;
    userId: string;
    nickname: string;
    amount: number;
    bidCount: number;
    minNextBid: number;
    endsAt: Date;
    extended: boolean;
    now: Date;
    before: { highestBidderId?: Types.ObjectId | null; title: string };
  }): Promise<PlaceBidResult> {
    const previous = p.before.highestBidderId?.toString();
    // 서로 의존하지 않으니 동시에 보낸다 (DB 왕복 한 번을 줄인다). notify는 예외를 던지지 않는다.
    const [record] = await Promise.all([
      this.record(p.auctionId, p.userId, p.nickname, p.amount),
      previous && previous !== p.userId
        ? this.notifications.notify(previous, {
            type: 'outbid',
            auctionId: p.auctionId,
            title: p.before.title,
            amount: p.amount,
          })
        : undefined,
    ]);
    const result: PlaceBidResult = {
      bid: {
        id: record?.id ?? '',
        amount: p.amount,
        bidder: maskNickname(p.nickname),
        createdAt: record?.createdAt ?? p.now,
      },
      currentPrice: p.amount,
      bidCount: p.bidCount,
      minNextBid: p.minNextBid,
      highestBidderId: p.userId,
      endsAt: p.endsAt,
      extended: p.extended,
    };

    this.gateway.emitBid({ auctionId: p.auctionId, ...result });
    return result;
  }

  /** 경매 문서가 기준이므로 기록 저장이 실패해도 입찰 자체는 유효하다. 한 번 재시도하고 로그를 남긴다. */
  private async record(auctionId: string, userId: string, nickname: string, amount: number) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return (await this.bids.create({ auctionId, bidderId: userId, bidderNickname: nickname, amount })) as BidDocument & {
          createdAt: Date;
        };
      } catch (err) {
        this.logger.error(
          `bid record failed (attempt ${attempt}) auction=${auctionId} user=${userId} amount=${amount}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }
    return null;
  }

  private async explainRejection(auctionId: string, userId: string, amount: number, now: Date) {
    const a = await this.auctions.findById(auctionId).exec();
    if (!a) return new NotFoundException('경매를 찾을 수 없습니다');
    if (a.sellerId.toString() === userId) {
      return new ForbiddenException('본인의 경매에는 입찰할 수 없습니다');
    }
    if (a.suspended) return new ConflictException('관리자에 의해 중지된 경매입니다');
    if (now < a.startsAt) return new ConflictException('아직 시작되지 않은 경매입니다');
    if (now >= a.endsAt) return new ConflictException('이미 종료된 경매입니다');
    if (a.highestBidderId?.toString() === userId) {
      return new ConflictException('이미 최고가 입찰자입니다');
    }
    const min = a.bidCount === 0 ? a.startPrice : a.currentPrice + a.minIncrement;
    return new ConflictException(
      `입찰가가 너무 낮거나 이미 더 높은 입찰이 있습니다 (최소 ${won(min)})`,
    );
  }

  private async explainBuyNowRejection(auctionId: string, userId: string, now: Date) {
    const a = await this.auctions.findById(auctionId).exec();
    if (!a) return new NotFoundException('경매를 찾을 수 없습니다');
    if (a.sellerId.toString() === userId) {
      return new ForbiddenException('본인의 경매는 구매할 수 없습니다');
    }
    if (a.suspended) return new ConflictException('관리자에 의해 중지된 경매입니다');
    if (now < a.startsAt) return new ConflictException('아직 시작되지 않은 경매입니다');
    if (now >= a.endsAt) return new ConflictException('이미 종료된 경매입니다');
    if (a.buyNowPrice == null) return new ConflictException('즉시구매가 없는 경매입니다');
    return new ConflictException('현재가가 즉시구매가에 도달해 즉시구매할 수 없습니다');
  }

  private assertValidId(id: string): void {
    if (!isValidObjectId(id)) throw new BadRequestException('잘못된 경매 ID');
  }
}
