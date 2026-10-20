import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { AppModule } from './app.module.js';
import { BidsController } from './bids/bids.controller.js';
import { BidsGateway } from './bids/bids.gateway.js';
import { BidsService } from './bids/bids.service.js';
import { OrdersController } from './orders/orders.controller.js';
import { SettlementService } from './settlement/settlement.service.js';

/**
 * MongoDB 없이 모듈 의존성 그래프(순환 참조, 누락된 export/import)만 검증한다.
 * 실제 연결 대신 모델 껍데기를 돌려주는 가짜 커넥션을 쓴다.
 */
describe('AppModule 의존성 그래프', () => {
  it('모든 모듈이 해석되고 핵심 프로바이더가 연결된다', async () => {
    process.env.DISABLE_SCHEDULERS = 'true';
    process.env.JWT_SECRET ??= 'test-secret';

    const fakeConnection = {
      models: {},
      model: (name: string) => ({ modelName: name }),
      close: async () => {},
    };
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(getConnectionToken())
      .useValue(fakeConnection)
      .compile();

    expect(module.get(BidsService)).toBeDefined();
    expect(module.get(BidsController)).toBeDefined();
    expect(module.get(OrdersController)).toBeDefined();
    expect(module.get(SettlementService, { strict: false })).toBeDefined();
    // 입찰 모듈과 정산 모듈이 같은 게이트웨이 인스턴스를 공유해야 알림이 같은 소켓 서버로 나간다.
    const gateway = module.get(BidsGateway, { strict: false });
    expect((module.get(BidsService) as unknown as { gateway: unknown }).gateway).toBe(gateway);
    expect((module.get(SettlementService, { strict: false }) as unknown as { gateway: unknown }).gateway).toBe(
      gateway,
    );
    await module.close();
  });
});
