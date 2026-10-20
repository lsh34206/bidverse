import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { Auction } from '../auctions/auction.schema.js';
import { AuctionsService } from '../auctions/auctions.service.js';
import { Bid } from '../bids/bid.schema.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { Order } from '../orders/order.schema.js';
import { UsersService } from '../users/users.service.js';
import { AdminService } from './admin.service.js';
import { AuditLog } from './audit-log.schema.js';
import { Report } from './report.schema.js';

const oid = () => new Types.ObjectId();
const exec = <T>(value: T) => ({ exec: () => Promise.resolve(value) });

describe('AdminService', () => {
  let service: AdminService;
  const auctions = { findOneAndUpdate: vi.fn(), exists: vi.fn() };
  const reports = { findById: vi.fn(), updateMany: vi.fn(), updateOne: vi.fn() };
  const audit = { create: vi.fn() };
  const users = { updateById: vi.fn() };
  const auctionsService = { findOne: vi.fn(), list: vi.fn() };
  const notifications = { notify: vi.fn() };

  const adminId = oid().toString();
  const auctionId = oid().toString();
  const sellerId = oid();

  beforeEach(async () => {
    vi.clearAllMocks();
    audit.create.mockResolvedValue({});
    auctionsService.findOne.mockResolvedValue({ id: auctionId });
    const module = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: getModelToken(Auction.name), useValue: auctions },
        { provide: getModelToken(Bid.name), useValue: {} },
        { provide: getModelToken(Order.name), useValue: {} },
        { provide: getModelToken(Report.name), useValue: reports },
        { provide: getModelToken(AuditLog.name), useValue: audit },
        { provide: UsersService, useValue: users },
        { provide: AuctionsService, useValue: auctionsService },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = module.get(AdminService);
  });

  describe('경매 중지/복구', () => {
    it('중지하면 사유를 저장하고, 판매자에게 알리고, 감사 로그를 남긴다', async () => {
      auctions.findOneAndUpdate.mockReturnValue(exec({ sellerId, title: '시계' }));

      await service.suspendAuction(adminId, auctionId, '허위 매물');

      const [filter, update] = auctions.findOneAndUpdate.mock.calls[0];
      expect(filter).toEqual({ _id: auctionId, suspended: { $ne: true } });
      expect(update.$set).toEqual({ suspended: true, suspendedReason: '허위 매물' });
      expect(notifications.notify).toHaveBeenCalledWith(
        sellerId.toString(),
        expect.objectContaining({ type: 'suspended', message: '허위 매물', auctionId }),
      );
      expect(audit.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auction.suspend', targetId: auctionId }),
      );
    });

    it('이미 중지된 경매는 409, 없는 경매는 404', async () => {
      auctions.findOneAndUpdate.mockReturnValue(exec(null));
      auctions.exists.mockReturnValue(exec({ _id: 1 }));
      await expect(service.suspendAuction(adminId, auctionId, '사유')).rejects.toBeInstanceOf(
        ConflictException,
      );
      auctions.exists.mockReturnValue(exec(null));
      await expect(service.suspendAuction(adminId, auctionId, '사유')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(notifications.notify).not.toHaveBeenCalled();
    });

    it('복구하면 중지 표시와 사유를 지우고 판매자에게 알린다', async () => {
      auctions.findOneAndUpdate.mockReturnValue(exec({ sellerId, title: '시계' }));

      await service.restoreAuction(adminId, auctionId);

      const [filter, update] = auctions.findOneAndUpdate.mock.calls[0];
      expect(filter).toEqual({ _id: auctionId, suspended: true });
      expect(update.$set).toEqual({ suspended: false });
      expect(update.$unset).toHaveProperty('suspendedReason');
      expect(notifications.notify).toHaveBeenCalledWith(
        sellerId.toString(),
        expect.objectContaining({ type: 'restored' }),
      );
    });

    it('감사 로그 기록이 실패해도 조치는 성공으로 돌려준다', async () => {
      auctions.findOneAndUpdate.mockReturnValue(exec({ sellerId, title: '시계' }));
      audit.create.mockRejectedValue(new Error('db down'));
      await expect(service.suspendAuction(adminId, auctionId, '사유')).resolves.toBeDefined();
    });
  });

  describe('사용자 관리', () => {
    const target = oid().toString();
    const userDoc = { id: target, email: 'a@b.com', nickname: 'n', role: 'buyer', status: 'banned', createdAt: new Date() };

    it('본인 계정은 바꿀 수 없다', async () => {
      await expect(service.updateUser(adminId, adminId, { role: 'buyer' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(users.updateById).not.toHaveBeenCalled();
    });

    it('변경 항목이 없으면 400', async () => {
      await expect(service.updateUser(adminId, target, {})).rejects.toBeInstanceOf(BadRequestException);
    });

    it('정지하면 사유를 저장한다 (없으면 기본 사유)', async () => {
      users.updateById.mockResolvedValue(userDoc);
      await service.updateUser(adminId, target, { status: 'banned', reason: '사기 의심' });
      expect(users.updateById).toHaveBeenCalledWith(
        target,
        { status: 'banned', bannedReason: '사기 의심' },
        false,
      );
      await service.updateUser(adminId, target, { status: 'banned' });
      expect(users.updateById.mock.calls[1][1].bannedReason).toBe('운영 정책 위반');
    });

    it('정지를 풀면 사유를 지운다', async () => {
      users.updateById.mockResolvedValue({ ...userDoc, status: 'active' });
      await service.updateUser(adminId, target, { status: 'active' });
      expect(users.updateById).toHaveBeenCalledWith(target, { status: 'active' }, true);
    });

    it('없는 사용자는 404', async () => {
      users.updateById.mockResolvedValue(null);
      await expect(service.updateUser(adminId, target, { role: 'seller' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('신고 처리', () => {
    const reportId = oid().toString();
    const open = (over: Record<string, unknown> = {}) => ({
      id: reportId,
      auctionId: new Types.ObjectId(auctionId),
      reporterId: oid(),
      reason: '가짜 상품',
      status: 'open',
      ...over,
    });
    const reload = () =>
      reports.findById
        .mockReturnValueOnce(exec(open()))
        .mockReturnValueOnce({ populate: () => ({ populate: () => exec(open({ status: 'resolved' })) }) });

    it('중지 처리하면 경매를 중지하고 같은 경매의 다른 신고도 함께 처리한다', async () => {
      reload();
      auctions.findOneAndUpdate.mockReturnValue(exec({ sellerId, title: '시계' }));
      reports.updateMany.mockReturnValue(exec({}));

      await service.resolveReport(adminId, reportId, { action: 'suspend' });

      expect(auctions.findOneAndUpdate).toHaveBeenCalled();
      const [filter, update] = reports.updateMany.mock.calls[0];
      expect(filter).toMatchObject({ status: 'open' });
      expect(update.$set).toMatchObject({ status: 'resolved', resolution: 'suspended' });
    });

    it('경매가 이미 중지돼 있어도 신고 처리는 마무리된다', async () => {
      reload();
      auctions.findOneAndUpdate.mockReturnValue(exec(null));
      auctions.exists.mockReturnValue(exec({ _id: 1 })); // 이미 중지됨 -> Conflict
      reports.updateMany.mockReturnValue(exec({}));

      await expect(service.resolveReport(adminId, reportId, { action: 'suspend' })).resolves.toBeDefined();
      expect(reports.updateMany).toHaveBeenCalled();
    });

    it('기각하면 경매는 건드리지 않고 이 신고만 처리한다', async () => {
      reload();
      reports.updateOne.mockReturnValue(exec({}));

      await service.resolveReport(adminId, reportId, { action: 'dismiss', note: '문제 없음' });

      expect(auctions.findOneAndUpdate).not.toHaveBeenCalled();
      expect(reports.updateOne.mock.calls[0][1].$set).toMatchObject({
        resolution: 'dismissed',
        note: '문제 없음',
      });
    });

    it('이미 처리된 신고는 409', async () => {
      reports.findById.mockReturnValue(exec(open({ status: 'resolved' })));
      await expect(service.resolveReport(adminId, reportId, { action: 'dismiss' })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });
});
