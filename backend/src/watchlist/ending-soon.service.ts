import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ENDING_SOON_INTERVAL_MS, ENDING_SOON_WINDOW_MS } from '../auctions/auction.constants.js';
import { Auction } from '../auctions/auction.schema.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { WatchlistService } from './watchlist.service.js';

/**
 * 마감 1시간 전이 된 경매를 관심 목록에 담은 사용자에게 한 번만 알려 준다.
 * `endingSoonNotifiedAt`을 조건부로 찍는 데 성공한 쪽만 알림을 보내서
 * 서버가 여러 대여도 중복 발송되지 않는다.
 */
@Injectable()
export class EndingSoonService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EndingSoonService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @InjectModel(Auction.name) private readonly auctions: Model<Auction>,
    private readonly watchlist: WatchlistService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    if (process.env.DISABLE_SCHEDULERS === 'true') return;
    this.timer = setInterval(() => void this.sweep(), ENDING_SOON_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** 알림을 보낸 경매 수를 돌려준다. */
  async sweep(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const soon = new Date(now.getTime() + ENDING_SOON_WINDOW_MS);
      const due = await this.auctions
        .find({
          suspended: { $ne: true },
          endingSoonNotifiedAt: null,
          startsAt: { $lte: now },
          endsAt: { $gt: now, $lte: soon },
        })
        .limit(100)
        .exec();

      let notified = 0;
      for (const auction of due) {
        try {
          const claimed = await this.auctions
            .findOneAndUpdate(
              { _id: auction._id, endingSoonNotifiedAt: null },
              { $set: { endingSoonNotifiedAt: now } },
            )
            .exec();
          if (!claimed) continue; // 다른 인스턴스가 먼저 처리했다.

          const sellerId = auction.sellerId.toString();
          const watchers = (await this.watchlist.watcherIds(auction.id)).filter((id) => id !== sellerId);
          for (const userId of watchers) {
            await this.notifications.notify(userId, {
              type: 'ending',
              auctionId: auction.id,
              title: auction.title,
              amount: auction.currentPrice,
            });
          }
          notified++;
        } catch (err) {
          this.logger.error(
            `ending-soon failed auction=${auction.id}`,
            err instanceof Error ? err.stack : String(err),
          );
        }
      }
      return notified;
    } catch (err) {
      this.logger.error('ending-soon sweep failed', err instanceof Error ? err.stack : String(err));
      return 0;
    } finally {
      this.running = false;
    }
  }
}
