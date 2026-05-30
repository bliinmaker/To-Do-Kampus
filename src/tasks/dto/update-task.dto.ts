import { ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { CreateTaskDto } from './create-task.dto';

export class UpdateTaskDto extends PartialType(
  OmitType(CreateTaskDto, ['description'] as const),
) {
  @ApiPropertyOptional({ example: 'Updated description', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;
}
