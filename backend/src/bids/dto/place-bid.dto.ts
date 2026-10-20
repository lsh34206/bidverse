import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export class PlaceBidDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000_000_000)
  amount: number;
}
