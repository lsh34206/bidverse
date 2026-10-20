import { ArrayMaxSize, IsArray, IsMongoId, IsOptional } from 'class-validator';

export class MarkReadDto {
  /** 비우면 전부 읽음 처리 */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsMongoId({ each: true })
  ids?: string[];
}
