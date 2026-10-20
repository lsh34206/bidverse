import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BidsGateway } from '../bids/bids.gateway.js';

/** 소켓 게이트웨이를 입찰·정산 모듈이 함께 쓸 수 있도록 따로 둔다. */
@Module({
  imports: [AuthModule],
  providers: [BidsGateway],
  exports: [BidsGateway],
})
export class RealtimeModule {}
