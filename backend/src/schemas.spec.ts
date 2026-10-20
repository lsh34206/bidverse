import { SchemaFactory } from '@nestjs/mongoose';
import { AuditLog } from './admin/audit-log.schema.js';
import { Report } from './admin/report.schema.js';
import { Auction } from './auctions/auction.schema.js';
import { Bid } from './bids/bid.schema.js';
import { ChatMessage } from './chat/chat-message.schema.js';
import { Notification } from './notifications/notification.schema.js';
import { Order } from './orders/order.schema.js';
import { Payment } from './payments/payment.schema.js';
import { User } from './users/user.schema.js';
import { Watch } from './watchlist/watch.schema.js';

/**
 * 회귀 방지: `@Prop({ type: Types.ObjectId })`처럼 bson 클래스를 type으로 쓰면
 * Mongoose가 필드를 Mixed로 잡아서 캐스팅/populate/비교가 조용히 깨진다.
 * 참조(ref)가 있는 필드는 반드시 ObjectId여야 한다.
 */
describe('스키마 ID 필드 타입', () => {
  const classes = { User, Auction, Bid, Order, Payment, Notification, Watch, Report, AuditLog, ChatMessage };

  for (const [name, cls] of Object.entries(classes)) {
    it(`${name}: ref가 있는 필드는 모두 ObjectId`, () => {
      const schema = SchemaFactory.createForClass(cls);
      const refPaths = Object.entries(schema.paths).filter(([, p]) => (p as any).options?.ref);
      for (const [path, p] of refPaths) {
        expect(`${name}.${path}=${(p as any).instance}`).toBe(`${name}.${path}=ObjectId`);
      }
    });
  }

  it('검사 대상이 실제로 존재한다 (빈 검사 방지)', () => {
    const total = Object.values(classes).flatMap((cls) =>
      Object.values(SchemaFactory.createForClass(cls).paths).filter((p) => (p as any).options?.ref),
    );
    expect(total.length).toBeGreaterThanOrEqual(19);
  });
});
