import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { JwtAuthGuard, type AuthUser } from '../auth/jwt-auth.guard.js';
import { UserThrottlerGuard } from '../common/user-throttler.guard.js';
import { ConfirmPaymentDto, RefundDto } from './payments.dto.js';
import { PaymentsService } from './payments.service.js';

@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /** 결제창을 열기 전에 주문번호/금액을 서버가 확정해서 내려준다. */
  @Post('orders/:id/payment')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, UserThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  prepare(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.payments.prepare(user, id);
  }

  /** 결제 인증이 끝난 뒤 successUrl 페이지가 부른다. 여기서 토스에 승인을 요청한다. */
  @Post('payments/confirm')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, UserThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  confirm(@CurrentUser() user: AuthUser, @Body() dto: ConfirmPaymentDto) {
    return this.payments.confirm(user, dto);
  }

  /** 구매자는 발송 전 환불, 관리자는 결제 이후 어느 단계든 환불 */
  @Post('orders/:id/refund')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, UserThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  refund(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: RefundDto) {
    return this.payments.refund(user, id, dto.reason);
  }

  /** 관리자 환불 (구매자가 아니어도 가능). 위 refund와 같은 로직이고 관리자 권한을 명시적으로 요구한다. */
  @Post('admin/orders/:id/refund')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, AdminGuard)
  adminRefund(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: RefundDto) {
    return this.payments.refund(user, id, dto.reason);
  }

  /**
   * 토스 웹훅 수신 (토스 개발자센터에 이 URL을 등록: https://도메인/api/payments/webhook).
   * 인증 헤더가 없으므로 본문을 믿지 않고 토스에 다시 조회해서 처리한다. 항상 200으로 응답한다.
   */
  @Post('payments/webhook')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async webhook(@Body() payload: unknown) {
    await this.payments.handleWebhook(payload);
    return { ok: true };
  }
}
