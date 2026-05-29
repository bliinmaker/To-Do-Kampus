import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TaskStatus } from '@prisma/client';

export class TaskEntity {
  @ApiProperty({ example: '6f2b1c1e-9b3a-4f0d-9e3a-1b2c3d4e5f6a' })
  id!: string;

  @ApiProperty({ example: 'Buy groceries' })
  title!: string;

  @ApiPropertyOptional({ example: 'Milk, eggs, bread', nullable: true })
  description!: string | null;

  @ApiProperty({ enum: TaskStatus, example: TaskStatus.todo })
  status!: TaskStatus;

  @ApiProperty({ example: '2026-05-29T10:00:00.000Z' })
  createdAt!: Date;

  @ApiProperty({ example: '2026-05-29T10:00:00.000Z' })
  updatedAt!: Date;

  @ApiPropertyOptional({ example: null, nullable: true })
  deletedAt!: Date | null;
}

export class PaginationMeta {
  @ApiProperty({ example: 42 })
  total!: number;

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 10 })
  limit!: number;

  @ApiProperty({ example: 5 })
  totalPages!: number;
}

export class PaginatedTasksDto {
  @ApiProperty({ type: [TaskEntity] })
  data!: TaskEntity[];

  @ApiProperty({ type: PaginationMeta })
  meta!: PaginationMeta;
}
