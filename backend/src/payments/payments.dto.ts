import { Type } from 'class-transformer';
import { IsInt, IsString, Length, Matches, Max, Min } from 'class-validator';

export class ConfirmPaymentDto {
  /** 토스가 결제 인증 후 successUrl 쿼리로 넘겨준 값 (최대 200자) */
  @IsString()
  @Length(1, 200)
  paymentKey: string;

  /** prepare 에서 내려준 토스 주문번호 */
  @IsString()
  @Matches(/^[A-Za-z0-9_=-]{6,64}$/)
  orderId: string;

  /** 클라이언트가 보낸 금액. 서버가 저장해 둔 금액과 같을 때만 승인한다. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000_000_000)
  amount: number;
}

export class RefundDto {
  @IsString()
  @Length(2, 200)
  reason: string;
}
