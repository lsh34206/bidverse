import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { PaymentsController } from './payments.controller.js';
import { resolvePaymentsConfig, type PaymentsConfig } from './payments.config.js';
import { PaymentsReconcileService } from './payments-reconcile.service.js';
import { PAYMENTS_CONFIG, PaymentsService } from './payments.service.js';
import { Payment, PaymentSchema } from './payment.schema.js';
import { HttpTossClient, MockTossClient, TossClient } from './toss.client.js';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Payment.name, schema: PaymentSchema }]),
    AuthModule,
    OrdersModule,
    NotificationsModule,
  ],
  controllers: [PaymentsController],
  providers: [
    {
      provide: PAYMENTS_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService): PaymentsConfig =>
        resolvePaymentsConfig({
          TOSS_CLIENT_KEY: config.get('TOSS_CLIENT_KEY'),
          TOSS_SECRET_KEY: config.get('TOSS_SECRET_KEY'),
          TOSS_API_BASE: config.get('TOSS_API_BASE'),
          PAYMENT_MOCK: config.get('PAYMENT_MOCK'),
          NODE_ENV: config.get('NODE_ENV'),
          JWT_SECRET: config.get('JWT_SECRET'),
        }),
    },
    {
      provide: TossClient,
      inject: [PAYMENTS_CONFIG],
      useFactory: (cfg: PaymentsConfig): TossClient =>
        cfg.mode === 'toss' ? new HttpTossClient(cfg.secretKey!, cfg.apiBase) : new MockTossClient(),
    },
    PaymentsService,
    PaymentsReconcileService,
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
