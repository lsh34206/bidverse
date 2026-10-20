import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';

export class CreateReportDto {
  @IsString()
  @Length(5, 500)
  reason: string;
}

export class SuspendDto {
  @IsString()
  @Length(2, 300)
  reason: string;
}

export class UpdateUserDto {
  @IsOptional()
  @IsIn(['buyer', 'seller', 'admin'])
  role?: 'buyer' | 'seller' | 'admin';

  @IsOptional()
  @IsIn(['active', 'banned'])
  status?: 'active' | 'banned';

  /** 정지 사유 (status가 banned일 때) */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class ResolveReportDto {
  @IsIn(['suspend', 'dismiss'])
  action: 'suspend' | 'dismiss';

  /** suspend일 때는 중지 사유로도 쓰인다. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class PageQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class UsersQuery extends PageQuery {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class OrdersQuery extends PageQuery {
  @IsOptional()
  @IsIn(['pending', 'paid', 'shipped', 'done', 'refunded'])
  status?: 'pending' | 'paid' | 'shipped' | 'done' | 'refunded';
}

export class ReportsQuery extends PageQuery {
  @IsOptional()
  @IsIn(['open', 'resolved'])
  status?: 'open' | 'resolved';
}
