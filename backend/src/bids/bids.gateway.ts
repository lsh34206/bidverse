import { Logger, OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { isValidObjectId } from 'mongoose';
import type { Server, Socket } from 'socket.io';

export interface BidEvent {
  auctionId: string;
  bid: { id: string; amount: number; bidder: string; createdAt: Date };
  currentPrice: number;
  bidCount: number;
  minNextBid: number;
  highestBidderId: string;
  endsAt: Date;
  /** 이 입찰로 종료 시각이 연장되었는지 */
  extended: boolean;
}

export interface EndedEvent {
  auctionId: string;
  result: 'sold' | 'unsold';
  winner?: string;
  finalPrice?: number;
}

export interface NotifyEvent {
  type: 'outbid' | 'won' | 'sold' | 'unsold' | 'ending' | 'suspended' | 'restored' | 'paid' | 'refunded';
  auctionId: string;
  title: string;
  amount?: number;
  orderId?: string;
  /** 관리자 조치 사유 등 부가 설명 */
  message?: string;
  /** 알림 센터에 저장된 알림이면 그 id (읽음 처리에 쓴다) */
  id?: string;
  createdAt?: Date;
}

/** 경매 채팅방 메시지 한 건 (REST 응답과 소켓 이벤트가 같은 모양이다) */
export interface ChatEvent {
  id: string;
  auctionId: string;
  userId: string;
  nickname: string;
  text: string;
  isSeller: boolean;
  isAdmin: boolean;
  createdAt: Date;
}

const auctionRoom = (id: string) => `auction:${id}`;
const userRoom = (id: string) => `user:${id}`;
const AUCTION_ROOM_PREFIX = 'auction:';
/** 입장/퇴장이 몰릴 때 접속자 수 집계를 방마다 이 간격으로 한 번만 한다 */
const VIEWERS_DEBOUNCE_MS = 300;

@WebSocketGateway({ cors: { origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173' } })
export class BidsGateway implements OnGatewayConnection, OnModuleDestroy {
  private readonly logger = new Logger(BidsGateway.name);

  @WebSocketServer()
  private server: Server;

  /** 경매방별 마지막으로 집계한 접속자 수 (입장 응답에 바로 실어 주려고 둔다) */
  private readonly viewerCounts = new Map<string, number>();
  private readonly viewerTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly jwt: JwtService) {}

  onModuleDestroy(): void {
    this.viewerTimers.forEach((t) => clearTimeout(t));
    this.viewerTimers.clear();
  }

  /** 토큰이 있으면 개인 알림용 룸에 넣는다. 토큰이 없거나 틀려도 관전(구독)은 가능하다. */
  async handleConnection(client: Socket): Promise<void> {
    // 연결이 끊기면(탭 닫기 등) 들어가 있던 경매방의 접속자 수를 다시 센다.
    client.on('disconnecting', () => {
      for (const room of client.rooms) {
        if (room.startsWith(AUCTION_ROOM_PREFIX)) this.scheduleViewers(room.slice(AUCTION_ROOM_PREFIX.length));
      }
    });

    const token = (client.handshake.auth as { token?: unknown } | undefined)?.token;
    if (typeof token !== 'string' || !token) return;
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string }>(token);
      await client.join(userRoom(payload.sub));
    } catch {
      this.logger.debug(`socket ${client.id}: invalid token, continuing as guest`);
    }
  }

  @SubscribeMessage('auction:join')
  async join(@ConnectedSocket() client: Socket, @MessageBody() body: { auctionId?: unknown }) {
    if (typeof body?.auctionId !== 'string' || !isValidObjectId(body.auctionId)) {
      return { ok: false };
    }
    await client.join(auctionRoom(body.auctionId));
    this.scheduleViewers(body.auctionId);
    // viewers 는 직전 집계값이라 조금 어긋날 수 있다. 곧 auction:viewers 이벤트로 정확한 값이 온다.
    return { ok: true, serverTime: Date.now(), viewers: this.viewerCounts.get(body.auctionId) };
  }

  @SubscribeMessage('auction:leave')
  async leave(@ConnectedSocket() client: Socket, @MessageBody() body: { auctionId?: unknown }) {
    if (typeof body?.auctionId === 'string') {
      await client.leave(auctionRoom(body.auctionId));
      this.scheduleViewers(body.auctionId);
    }
    return { ok: true };
  }

  /**
   * 경매방에 있는 접속자 수를 세서 방 전체에 알린다. 입장·퇴장이 몰려도 방마다 한 번만 센다.
   * fetchSockets 는 Redis 어댑터를 쓰면 서버 인스턴스 전체를 합산해 준다.
   */
  private scheduleViewers(auctionId: string): void {
    if (this.viewerTimers.has(auctionId)) return;
    const timer = setTimeout(() => {
      this.viewerTimers.delete(auctionId);
      void this.server
        .in(auctionRoom(auctionId))
        .fetchSockets()
        .then((sockets) => {
          const count = sockets.length;
          if (count === 0) this.viewerCounts.delete(auctionId);
          else this.viewerCounts.set(auctionId, count);
          this.server.to(auctionRoom(auctionId)).emit('auction:viewers', { auctionId, count });
        })
        .catch((err: unknown) => this.logger.debug(`viewers count failed: ${String(err)}`));
    }, VIEWERS_DEBOUNCE_MS);
    timer.unref();
    this.viewerTimers.set(auctionId, timer);
  }

  emitChat(event: ChatEvent): void {
    this.server.to(auctionRoom(event.auctionId)).emit('chat:new', event);
  }

  emitChatDeleted(event: { auctionId: string; messageId: string }): void {
    this.server.to(auctionRoom(event.auctionId)).emit('chat:deleted', event);
  }

  emitBid(event: BidEvent): void {
    this.server.to(auctionRoom(event.auctionId)).emit('bid:new', event);
  }

  emitEnded(event: EndedEvent): void {
    this.server.to(auctionRoom(event.auctionId)).emit('auction:ended', event);
  }

  notifyUser(userId: string, event: NotifyEvent): void {
    this.server.to(userRoom(userId)).emit('notify', event);
  }
}
