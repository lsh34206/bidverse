import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerModule } from '@nestjs/throttler';
import { AdminModule } from './admin/admin.module.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuctionsModule } from './auctions/auctions.module.js';
import { AuthModule } from './auth/auth.module.js';
import { BidsModule } from './bids/bids.module.js';
import { ChatModule } from './chat/chat.module.js';
import { HealthController } from './health.controller.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { createRedis } from './redis/create-redis.js';
import { RedisThrottlerStorage } from './redis/redis-throttler.storage.js';
import { SettlementModule } from './settlement/settlement.module.js';
import { UsersModule } from './users/users.module.js';
import { WatchlistModule } from './watchlist/watchlist.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>('MONGODB_URI', 'mongodb://127.0.0.1:27017/bidverse'),
        // 접속 문자열의 DB 이름 대신 쓸 이름 (E2E·부하 테스트가 임시 DB로 돌 때 쓴다)
        dbName: config.get<string>('MONGODB_DB') || undefined,
        // 연결을 미리 몇 개 열어 둬서, 입찰이 몰릴 때 TLS 연결을 새로 맺느라 생기는 지연을 줄인다.
        minPoolSize: 5,
        maxPoolSize: Number(config.get<string>('MONGODB_POOL_MAX')) || 50,
      }),
    }),
    // 속도 제한. REDIS_URL이 있으면 카운터를 Redis에 둬서 여러 인스턴스가 한도를 함께 센다.
    // 어떤 라우트에 얼마나 거는지는 각 컨트롤러의 @Throttle 에 있다.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redisUrl = config.get<string>('REDIS_URL');
        return {
          throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }],
          storage: redisUrl ? new RedisThrottlerStorage(createRedis(redisUrl, 'throttler')) : undefined,
          // 테스트/부하 테스트에서 끈다. 운영에서는 설정하지 않는다.
          skipIf: () => process.env.THROTTLE_DISABLED === 'true',
        };
      },
    }),
    UsersModule,
    AuthModule,
    AuctionsModule,
    BidsModule,
    ChatModule,
    OrdersModule,
    PaymentsModule,
    SettlementModule,
    NotificationsModule,
    WatchlistModule,
    AdminModule,
  ],
  controllers: [AppController, HealthController],
  providers: [AppService],
})
export class AppModule {}
