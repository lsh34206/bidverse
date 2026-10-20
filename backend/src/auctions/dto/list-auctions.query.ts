import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export const AUCTION_SORTS = ['endingSoon', 'newest', 'priceAsc', 'priceDesc'] as const;
export const AUCTION_STATUS_FILTERS = ['scheduled', 'live', 'ended'] as const;

export class ListAuctionsQuery {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsIn(AUCTION_STATUS_FILTERS)
  status?: (typeof AUCTION_STATUS_FILTERS)[number];

  @IsOptional()
  @IsIn(AUCTION_SORTS)
  sort?: (typeof AUCTION_SORTS)[number];

  @IsOptional()
  @IsString()
  sellerId?: string;

  /** 관리자 목록에서만 의미가 있다: 'true'면 중지된 경매만 */
  @IsOptional()
  @IsIn(['true'])
  suspended?: 'true';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
