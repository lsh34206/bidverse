import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model, QueryFilter, SortOrder } from 'mongoose';
import type { AuthUser } from '../auth/jwt-auth.guard.js';
import { Auction, AuctionDocument, AuctionResult, AuctionStatus } from './auction.schema.js';
import type { CreateAuctionDto } from './dto/create-auction.dto.js';
import type { ListAuctionsQuery } from './dto/list-auctions.query.js';
import type { UpdateAuctionDto } from './dto/update-auction.dto.js';

const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

const SORTS: Record<NonNullable<ListAuctionsQuery['sort']>, Record<string, SortOrder>> = {
  endingSoon: { endsAt: 1 },
  newest: { createdAt: -1 },
  priceAsc: { currentPrice: 1 },
  priceDesc: { currentPrice: -1 },
};

export interface AuctionView {
  id: string;
  seller: { id: string; nickname: string | null };
  title: string;
  description: string;
  category: string;
  images: string[];
  startPrice: number;
  currentPrice: number;
  minIncrement: number;
  buyNowPrice: number | null;
  bidCount: number;
  minNextBid: number;
  highestBidderId: string | null;
  startsAt: Date;
  endsAt: Date;
  status: AuctionStatus;
  /** 정산이 끝난 경매의 결과. 정산 전이면 null */
  result: AuctionResult | null;
  /** 관리자에 의해 중지된 경매 */
  suspended: boolean;
  /** 중지 사유. 관리자 조회에만 채워진다. */
  suspendedReason: string | null;
  createdAt: Date;
}

export interface ViewOptions {
  /** 관리자 조회: 중지된 경매도 포함하고 중지 사유를 보여 준다. */
  admin?: boolean;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function statusOf(a: { startsAt: Date; endsAt: Date }, now = new Date()): AuctionStatus {
  if (now < a.startsAt) return 'scheduled';
  if (now < a.endsAt) return 'live';
  return 'ended';
}

@Injectable()
export class AuctionsService {
  constructor(@InjectModel(Auction.name) private readonly auctions: Model<Auction>) {}

  async create(user: AuthUser, dto: CreateAuctionDto): Promise<AuctionView> {
    const now = new Date();
    const startsAt = dto.startsAt ?? now;
    this.validate({ ...dto, startsAt }, now, true);

    const doc = await this.auctions.create({
      sellerId: user.id,
      sellerNickname: user.nickname,
      title: dto.title,
      description: dto.description,
      category: dto.category,
      images: dto.images,
      startPrice: dto.startPrice,
      currentPrice: dto.startPrice,
      minIncrement: dto.minIncrement,
      buyNowPrice: dto.buyNowPrice,
      startsAt,
      endsAt: dto.endsAt,
    });
    return this.findOne(doc.id);
  }

  async list(query: ListAuctionsQuery, opts: ViewOptions = {}) {
    const now = new Date();
    const filter: QueryFilter<Auction> = {};
    if (!opts.admin) filter.suspended = { $ne: true };
    else if (query.suspended === 'true') filter.suspended = true;
    if (query.q) filter.title = { $regex: escapeRegex(query.q), $options: 'i' };
    if (query.category) filter.category = query.category;
    if (query.sellerId) {
      if (!isValidObjectId(query.sellerId)) throw new BadRequestException('잘못된 sellerId');
      filter.sellerId = query.sellerId;
    }
    if (query.status === 'scheduled') filter.startsAt = { $gt: now };
    if (query.status === 'live') {
      filter.startsAt = { $lte: now };
      filter.endsAt = { $gt: now };
    }
    if (query.status === 'ended') filter.endsAt = { $lte: now };

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const [docs, total] = await Promise.all([
      this.auctions
        .find(filter)
        .sort(SORTS[query.sort ?? 'newest'])
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.auctions.countDocuments(filter).exec(),
    ]);
    return { items: docs.map((d) => this.toView(d, now, opts)), total, page, limit };
  }

  async findOne(id: string, opts: ViewOptions = {}): Promise<AuctionView> {
    return this.toView(await this.load(id), new Date(), opts);
  }

  /** id 목록 순서대로 경매를 돌려준다. 없어졌거나 중지된 경매는 건너뛴다. */
  async viewsByIds(ids: string[]): Promise<AuctionView[]> {
    const valid = ids.filter((id) => isValidObjectId(id));
    if (valid.length === 0) return [];
    const docs = await this.auctions
      .find({ _id: { $in: valid }, suspended: { $ne: true } })
      .exec();
    const byId = new Map(docs.map((d) => [d.id, d]));
    const now = new Date();
    return valid.flatMap((id) => {
      const doc = byId.get(id);
      return doc ? [this.toView(doc, now)] : [];
    });
  }

  async update(user: AuthUser, id: string, dto: UpdateAuctionDto): Promise<AuctionView> {
    const current = await this.load(id);
    this.assertCanModify(user, current);

    const merged = {
      startPrice: dto.startPrice ?? current.startPrice,
      buyNowPrice: dto.buyNowPrice ?? current.buyNowPrice,
      startsAt: dto.startsAt ?? current.startsAt,
      endsAt: dto.endsAt ?? current.endsAt,
    };
    // 이미 지난 시작/종료 시각을 그대로 두는 수정은 허용하고, 새로 지정한 값만 현재 시각과 비교한다.
    this.validate(merged, new Date(), dto.endsAt !== undefined || dto.startsAt !== undefined);

    const { startPrice, ...rest } = dto;
    const changes: Partial<Auction> = { ...rest };
    if (startPrice !== undefined) {
      changes.startPrice = startPrice;
      changes.currentPrice = startPrice;
    }

    const updated = await this.auctions
      .findOneAndUpdate(
        { _id: id, bidCount: 0 },
        // 종료 시각을 새로 잡으면(유찰된 경매 재등록) 정산 상태도 초기화해서 다시 진행되게 한다.
        dto.endsAt !== undefined
          ? { $set: { ...changes, settledAt: null }, $unset: { result: '' } }
          : { $set: changes },
        { returnDocument: 'after' },
      )
      .exec();
    if (!updated) throw new ConflictException('입찰이 시작되어 수정할 수 없습니다');
    return this.toView(updated);
  }

  async remove(user: AuthUser, id: string): Promise<void> {
    const current = await this.load(id);
    this.assertCanModify(user, current);
    const res = await this.auctions.deleteOne({ _id: id, bidCount: 0 }).exec();
    if (res.deletedCount === 0) {
      throw new ConflictException('입찰이 시작되어 삭제할 수 없습니다');
    }
  }

  private async load(id: string): Promise<AuctionDocument> {
    if (!isValidObjectId(id)) throw new NotFoundException('경매를 찾을 수 없습니다');
    const doc = await this.auctions.findById(id).exec();
    if (!doc) throw new NotFoundException('경매를 찾을 수 없습니다');
    return doc;
  }

  private assertCanModify(user: AuthUser, auction: AuctionDocument): void {
    if (auction.sellerId.toString() !== user.id && user.role !== 'admin') {
      throw new ForbiddenException('본인의 경매만 수정할 수 있습니다');
    }
    if (auction.suspended) {
      throw new ConflictException('관리자에 의해 중지된 경매는 수정/삭제할 수 없습니다');
    }
    if (auction.bidCount > 0) {
      throw new ConflictException('입찰이 시작된 경매는 수정/삭제할 수 없습니다');
    }
  }

  private validate(
    v: { startPrice: number; buyNowPrice?: number; startsAt: Date; endsAt: Date },
    now: Date,
    checkFuture: boolean,
  ): void {
    if (v.endsAt <= v.startsAt) {
      throw new BadRequestException('종료 시각은 시작 시각 이후여야 합니다');
    }
    if (checkFuture && v.endsAt <= now) {
      throw new BadRequestException('종료 시각은 현재 이후여야 합니다');
    }
    if (v.endsAt.getTime() - v.startsAt.getTime() > MAX_DURATION_MS) {
      throw new BadRequestException('경매 기간은 최대 30일입니다');
    }
    if (v.buyNowPrice !== undefined && v.buyNowPrice <= v.startPrice) {
      throw new BadRequestException('즉시구매가는 시작가보다 커야 합니다');
    }
  }

  private toView(doc: AuctionDocument, now = new Date(), opts: ViewOptions = {}): AuctionView {
    return {
      id: doc.id,
      seller: { id: String(doc.sellerId), nickname: doc.sellerNickname ?? null },
      title: doc.title,
      description: doc.description,
      category: doc.category,
      images: doc.images,
      startPrice: doc.startPrice,
      currentPrice: doc.currentPrice,
      minIncrement: doc.minIncrement,
      buyNowPrice: doc.buyNowPrice ?? null,
      bidCount: doc.bidCount,
      minNextBid: doc.bidCount === 0 ? doc.startPrice : doc.currentPrice + doc.minIncrement,
      highestBidderId: doc.highestBidderId?.toString() ?? null,
      startsAt: doc.startsAt,
      endsAt: doc.endsAt,
      status: statusOf(doc, now),
      result: doc.settledAt ? (doc.result ?? null) : null,
      suspended: !!doc.suspended,
      suspendedReason: opts.admin ? (doc.suspendedReason ?? null) : null,
      createdAt: (doc as unknown as { createdAt: Date }).createdAt,
    };
  }
}
