import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDate,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateAuctionDto {
  @IsString()
  @Length(1, 100)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  category?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUrl({ require_tld: false }, { each: true })
  images?: string[];

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000_000_000)
  startPrice: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  minIncrement?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000_000_000)
  buyNowPrice?: number;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  startsAt?: Date;

  @Type(() => Date)
  @IsDate()
  endsAt: Date;
}
