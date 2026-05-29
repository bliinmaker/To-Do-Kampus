import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Task } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { QueryTasksDto } from './dto/query-tasks.dto';
import { PaginatedTasksDto } from './dto/task-response.dto';

@Injectable()
export class TasksService {
  constructor(private readonly prisma: PrismaService) {}

  create(userId: string, dto: CreateTaskDto): Promise<Task> {
    return this.prisma.task.create({
      data: { ...dto, userId },
    });
  }

  async findAll(
    userId: string,
    query: QueryTasksDto,
  ): Promise<PaginatedTasksDto> {
    return this.paginate(userId, query, { deletedAt: null });
  }

  async findArchived(
    userId: string,
    query: QueryTasksDto,
  ): Promise<PaginatedTasksDto> {
    return this.paginate(userId, query, { deletedAt: { not: null } });
  }

  async findOne(userId: string, id: string): Promise<Task> {
    return this.getOwnedOrThrow(userId, id);
  }

  async update(userId: string, id: string, dto: UpdateTaskDto): Promise<Task> {
    const task = await this.getOwnedOrThrow(userId, id);

    if (task.deletedAt) {
      throw new ConflictException('Archived tasks cannot be edited');
    }

    return this.prisma.task.update({ where: { id }, data: dto });
  }

  async restore(userId: string, id: string): Promise<Task> {
    const task = await this.getOwnedOrThrow(userId, id);

    if (!task.deletedAt) {
      throw new ConflictException('Task is not archived');
    }

    return this.prisma.task.update({
      where: { id },
      data: { deletedAt: null },
    });
  }

  async archive(userId: string, id: string): Promise<Task> {
    const task = await this.getOwnedOrThrow(userId, id);

    if (task.deletedAt) {
      throw new ConflictException('Task is already archived');
    }

    return this.prisma.task.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  private async getOwnedOrThrow(userId: string, id: string): Promise<Task> {
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) {
      throw new NotFoundException('Task not found');
    }
    if (task.userId !== userId) {
      throw new ForbiddenException('You do not have access to this task');
    }
    return task;
  }

  private async paginate(
    userId: string,
    query: QueryTasksDto,
    extraWhere: Prisma.TaskWhereInput,
  ): Promise<PaginatedTasksDto> {
    const { page, limit, status } = query;
    const where: Prisma.TaskWhereInput = {
      userId,
      ...extraWhere,
      ...(status ? { status } : {}),
    };

    const [total, data] = await this.prisma.$transaction([
      this.prisma.task.count({ where }),
      this.prisma.task.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 0,
      },
    };
  }
}
