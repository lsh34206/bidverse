import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model, QueryFilter, Types } from 'mongoose';
import { Auction } from '../auctions/auction.schema.js';
import { AuctionsService } from '../auctions/auctions.service.js';
import type { ListAuctionsQuery } from '../auctions/dto/list-auctions.query.js';
import { Bid } from '../bids/bid.schema.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { Order, type OrderStatus } from '../orders/order.schema.js';
import { UsersService } from '../users/users.service.js';
import type { UserDocument } from '../users/user.schema.js';
import type { ResolveReportDto, UpdateUserDto } from './admin.dto.js';
import { AuditLog } from './audit-log.schema.js';
import { Report, ReportDocument } from './report.schema.js';

export interface AdminUserView {
  id: string;
  email: string;
  nickname: string;
  role: string;
  status: string;
  bannedReason: string | null;
  createdAt: Date;
}

const userView = (u: UserDocument): AdminUserView => ({
  id: u.id,
  email: u.email,
  nickname: u.nickname,
  role: u.role,
  status: u.status,
  bannedReason: u.bannedReason ?? null,
  createdAt: (u as unknown as { createdAt: Date }).createdAt,
});

@Injectable()
export class AdminService {
  constructor(
    @InjectModel(Auction.name) private readonly auctions: Model<Auction>,
    @InjectModel(Bid.name) private readonly bids: Model<Bid>,
    @InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectModel(Report.name) private readonly reports: Model<Report>,
    @InjectModel(AuditLog.name) private readonly audit: Model<AuditLog>,
    private readonly users: UsersService,
    private readonly auctionsService: AuctionsService,
    private readonly notifications: NotificationsService,
  ) {}

  async stats() {
    const now = new Date();
    const [users, auctions, live, suspended, bids, orders, openReports] = await Promise.all([
      this.users.count(),
      this.auctions.estimatedDocumentCount().exec(),
      this.auctions
        .countDocuments({ suspended: { $ne: true }, startsAt: { $lte: now }, endsAt: { $gt: now } })
        .exec(),
      this.auctions.countDocuments({ suspended: true }).exec(),
      this.bids.estimatedDocumentCount().exec(),
      this.orders.estimatedDocumentCount().exec(),
      this.reports.countDocuments({ status: 'open' }).exec(),
    ]);
    return { users, auctions, liveAuctions: live, suspendedAuctions: suspended, bids, orders, openReports };
  }

  // ---- 경매 ----

  listAuctions(query: ListAuctionsQuery) {
    return this.auctionsService.list(query, { admin: true });
  }

  async suspendAuction(adminId: string, auctionId: string, reason: string) {
    this.assertId(auctionId);
    const auction = await this.auctions
      .findOneAndUpdate(
        { _id: auctionId, suspended: { $ne: true } },
        { $set: { suspended: true, suspendedReason: reason } },
        { returnDocument: 'after' },
      )
      .exec();
    if (!auction) {
      const exists = await this.auctions.exists({ _id: auctionId }).exec();
      if (!exists) throw new NotFoundException('경매를 찾을 수 없습니다');
      throw new ConflictException('이미 중지된 경매입니다');
    }

    await this.log(adminId, 'auction.suspend', 'auction', auctionId, { reason });
    await this.notifications.notify(auction.sellerId.toString(), {
      type: 'suspended',
      auctionId,
      title: auction.title,
      message: reason,
    });
    return this.auctionsService.findOne(auctionId, { admin: true });
  }

  async restoreAuction(adminId: string, auctionId: string) {
    this.assertId(auctionId);
    const auction = await this.auctions
      .findOneAndUpdate(
        { _id: auctionId, suspended: true },
        { $set: { suspended: false }, $unset: { suspendedReason: '' } },
        { returnDocument: 'after' },
      )
      .exec();
    if (!auction) {
      const exists = await this.auctions.exists({ _id: auctionId }).exec();
      if (!exists) throw new NotFoundException('경매를 찾을 수 없습니다');
      throw new ConflictException('중지된 경매가 아닙니다');
    }

    await this.log(adminId, 'auction.restore', 'auction', auctionId);
    await this.notifications.notify(auction.sellerId.toString(), {
      type: 'restored',
      auctionId,
      title: auction.title,
    });
    return this.auctionsService.findOne(auctionId, { admin: true });
  }

  // ---- 주문 (환불 처리용) ----

  async listOrders(status: OrderStatus | undefined, page = 1, limit = 20) {
    const filter: QueryFilter<Order> = status ? { status } : {};
    const [docs, total] = await Promise.all([
      this.orders
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('buyerId', 'nickname')
        .populate('sellerId', 'nickname')
        .exec(),
      this.orders.countDocuments(filter).exec(),
    ]);
    const nick = (ref: unknown) => (ref as { nickname?: string } | null)?.nickname ?? null;
    return {
      items: docs.map((o) => ({
        id: o.id,
        auctionId: String(o.auctionId),
        title: o.title,
        finalPrice: o.finalPrice,
        status: o.status,
        buyer: nick(o.buyerId),
        seller: nick(o.sellerId),
        createdAt: (o as unknown as { createdAt: Date }).createdAt,
      })),
      total,
      page,
      limit,
    };
  }

  // ---- 사용자 ----

  async listUsers(q: string | undefined, page = 1, limit = 20) {
    const { items, total } = await this.users.search(q, page, limit);
    return { items: items.map(userView), total, page, limit };
  }

  async updateUser(adminId: string, targetId: string, dto: UpdateUserDto) {
    this.assertId(targetId);
    if (targetId === adminId) {
      // 자기 자신의 권한을 내리거나 스스로를 정지해 관리자가 아무도 없게 되는 사고를 막는다.
      throw new ForbiddenException('본인 계정은 변경할 수 없습니다');
    }
    if (dto.role === undefined && dto.status === undefined) {
      throw new BadRequestException('변경할 항목이 없습니다');
    }

    const changes: Parameters<UsersService['updateById']>[1] = {};
    if (dto.role !== undefined) changes.role = dto.role;
    if (dto.status !== undefined) changes.status = dto.status;
    if (dto.status === 'banned') changes.bannedReason = dto.reason ?? '운영 정책 위반';
    const unsetReason = dto.status === 'active';

    const user = await this.users.updateById(targetId, changes, unsetReason);
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다');

    await this.log(adminId, 'user.update', 'user', targetId, {
      role: dto.role,
      status: dto.status,
      reason: dto.reason,
    });
    return userView(user);
  }

  // ---- 신고 ----

  async listReports(status: 'open' | 'resolved' | undefined, page = 1, limit = 20) {
    const filter = status ? { status } : {};
    const [docs, total] = await Promise.all([
      this.reports
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('auctionId', 'title suspended')
        .populate('reporterId', 'nickname')
        .exec(),
      this.reports.countDocuments(filter).exec(),
    ]);
    return { items: docs.map((d) => this.reportView(d)), total, page, limit };
  }

  async resolveReport(adminId: string, reportId: string, dto: ResolveReportDto) {
    this.assertId(reportId);
    const report = await this.reports.findById(reportId).exec();
    if (!report) throw new NotFoundException('신고를 찾을 수 없습니다');
    if (report.status === 'resolved') throw new ConflictException('이미 처리된 신고입니다');

    const auctionId = report.auctionId.toString();
    const now = new Date();
    if (dto.action === 'suspend') {
      try {
        await this.suspendAuction(adminId, auctionId, dto.note || `신고 처리: ${report.reason}`);
      } catch (err) {
        // 이미 중지된 경매라면 신고만 마무리하면 된다.
        if (!(err instanceof ConflictException)) throw err;
      }
      // 같은 경매에 쌓인 다른 신고도 함께 처리한다.
      await this.reports
        .updateMany(
          { auctionId: report.auctionId, status: 'open' },
          { $set: { status: 'resolved', resolution: 'suspended', resolvedBy: adminId, resolvedAt: now, note: dto.note } },
        )
        .exec();
    } else {
      await this.reports
        .updateOne(
          { _id: reportId, status: 'open' },
          { $set: { status: 'resolved', resolution: 'dismissed', resolvedBy: adminId, resolvedAt: now, note: dto.note } },
        )
        .exec();
    }

    await this.log(adminId, `report.${dto.action}`, 'report', reportId, { auctionId, note: dto.note });
    const updated = await this.reports
      .findById(reportId)
      .populate('auctionId', 'title suspended')
      .populate('reporterId', 'nickname')
      .exec();
    return this.reportView(updated as ReportDocument);
  }

  // ---- 감사 로그 ----

  async auditLog(limit = 100) {
    const docs = await this.audit
      .find()
      .sort({ createdAt: -1 })
      .limit(Math.min(limit, 200))
      .populate('adminId', 'nickname')
      .exec();
    return docs.map((d) => ({
      id: d.id,
      admin: (d.adminId as unknown as { nickname?: string } | null)?.nickname ?? '-',
      action: d.action,
      targetType: d.targetType,
      targetId: d.targetId,
      detail: d.detail ?? null,
      createdAt: (d as unknown as { createdAt: Date }).createdAt,
    }));
  }

  private log(
    adminId: string,
    action: string,
    targetType: AuditLog['targetType'],
    targetId: string,
    detail?: Record<string, unknown>,
  ) {
    return this.audit
      .create({ adminId: new Types.ObjectId(adminId), action, targetType, targetId, detail })
      .catch(() => undefined); // 기록 실패가 이미 끝난 조치를 되돌리지는 않는다.
  }

  private reportView(d: ReportDocument) {
    const auction = d.auctionId as unknown as { _id?: unknown; title?: string; suspended?: boolean };
    const reporter = d.reporterId as unknown as { _id?: unknown; nickname?: string };
    return {
      id: d.id,
      auction: {
        id: String(auction?._id ?? d.auctionId),
        title: auction?.title ?? '(삭제된 경매)',
        suspended: !!auction?.suspended,
      },
      reporter: { id: String(reporter?._id ?? d.reporterId), nickname: reporter?.nickname ?? null },
      reason: d.reason,
      status: d.status,
      resolution: d.resolution ?? null,
      note: d.note ?? null,
      createdAt: (d as unknown as { createdAt: Date }).createdAt,
      resolvedAt: d.resolvedAt ?? null,
    };
  }

  private assertId(id: string): void {
    if (!isValidObjectId(id)) throw new BadRequestException('잘못된 ID');
  }
}
