import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { BidsGateway, type NotifyEvent } from '../bids/bids.gateway.js';
import { Notification, NotificationDocument } from './notification.schema.js';

export interface NotificationView {
  id: string;
  type: NotifyEvent['type'];
  auctionId: string;
  title: string;
  amount: number | null;
  orderId: string | null;
  message: string | null;
  read: boolean;
  createdAt: Date;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectModel(Notification.name) private readonly notifications: Model<Notification>,
    private readonly gateway: BidsGateway,
  ) {}

  /**
   * 알림을 저장하고 접속 중이면 실시간으로도 보낸다.
   * 알림은 부가 기능이라 저장이 실패해도 호출한 쪽(입찰, 정산 등)을 깨뜨리지 않는다.
   * 저장에 실패하면 id 없이 실시간 전송만 한다.
   */
  async notify(userId: string, event: NotifyEvent): Promise<void> {
    let saved: NotificationDocument | null = null;
    try {
      saved = await this.notifications.create({
        userId,
        type: event.type,
        auctionId: event.auctionId,
        title: event.title,
        amount: event.amount,
        orderId: event.orderId,
        message: event.message,
      });
    } catch (err) {
      this.logger.error(
        `notification save failed user=${userId} type=${event.type}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
    this.gateway.notifyUser(userId, {
      ...event,
      id: saved?.id,
      createdAt: (saved as unknown as { createdAt?: Date } | null)?.createdAt ?? new Date(),
    });
  }

  async list(userId: string, page = 1, limit = 20) {
    const filter = { userId };
    const [docs, total, unreadCount] = await Promise.all([
      this.notifications
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.notifications.countDocuments(filter).exec(),
      this.unreadCount(userId),
    ]);
    return { items: docs.map((d) => this.toView(d)), total, unreadCount, page, limit };
  }

  unreadCount(userId: string): Promise<number> {
    return this.notifications.countDocuments({ userId, readAt: null }).exec();
  }

  /** ids를 주면 그 알림만, 비우면 전부 읽음 처리한다. 남의 알림은 userId 조건 때문에 건드려지지 않는다. */
  async markRead(userId: string, ids?: string[]): Promise<{ modified: number }> {
    const filter: Record<string, unknown> = { userId, readAt: null };
    if (ids?.length) filter._id = { $in: ids.filter((id) => isValidObjectId(id)) };
    const res = await this.notifications.updateMany(filter, { $set: { readAt: new Date() } }).exec();
    return { modified: res.modifiedCount };
  }

  private toView(d: NotificationDocument): NotificationView {
    return {
      id: d.id,
      type: d.type,
      auctionId: String(d.auctionId),
      title: d.title,
      amount: d.amount ?? null,
      orderId: d.orderId ? String(d.orderId) : null,
      message: d.message ?? null,
      read: !!d.readAt,
      createdAt: (d as unknown as { createdAt: Date }).createdAt,
    };
  }
}
