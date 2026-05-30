import { Test } from '@nestjs/testing';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { TaskStatus } from '@prisma/client';
import { TasksService } from './tasks.service';
import { TasksCleanupService } from './tasks-cleanup.service';
import { TasksGateway } from './tasks.gateway';
import { PrismaService } from '../prisma/prisma.service';

const cleanupMock = {
  scheduleCleanup: jest.fn(),
  cancelCleanup: jest.fn(),
};

const gatewayMock = {
  notifyUser: jest.fn(),
};

const prismaMock = {
  task: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
  },
  $transaction: jest.fn(),
};

const OWNER = 'user-1';
const OTHER = 'user-2';

const activeTask = {
  id: 'task-1',
  title: 'Test',
  description: null,
  status: TaskStatus.todo,
  userId: OWNER,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

describe('TasksService', () => {
  let service: TasksService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        TasksService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: TasksCleanupService, useValue: cleanupMock },
        { provide: TasksGateway, useValue: gatewayMock },
      ],
    }).compile();
    service = moduleRef.get(TasksService);
  });

  it('creates a task bound to the user', async () => {
    prismaMock.task.create.mockResolvedValue(activeTask);
    const result = await service.create(OWNER, { title: 'Test' });
    expect(prismaMock.task.create).toHaveBeenCalledWith({
      data: { title: 'Test', userId: OWNER },
    });
    expect(result).toEqual(activeTask);
  });

  it('returns 404 when the task does not exist', async () => {
    prismaMock.task.findUnique.mockResolvedValue(null);
    await expect(service.findOne(OWNER, 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('returns 403 when the task belongs to another user', async () => {
    prismaMock.task.findUnique.mockResolvedValue(activeTask);
    await expect(service.findOne(OTHER, 'task-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('blocks editing an archived task with 409', async () => {
    prismaMock.task.findUnique.mockResolvedValue({
      ...activeTask,
      deletedAt: new Date(),
    });
    await expect(
      service.update(OWNER, 'task-1', { title: 'New' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('archives by setting deletedAt instead of deleting the row', async () => {
    prismaMock.task.findUnique.mockResolvedValue(activeTask);
    prismaMock.task.update.mockResolvedValue({
      ...activeTask,
      deletedAt: new Date(),
    });

    await service.archive(OWNER, 'task-1');

    expect(prismaMock.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'task-1' },
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
  });

  it('restores an archived task by clearing deletedAt', async () => {
    const archivedTask = { ...activeTask, deletedAt: new Date() };
    prismaMock.task.findUnique.mockResolvedValue(archivedTask);
    prismaMock.task.update.mockResolvedValue({ ...activeTask, deletedAt: null });

    await service.restore(OWNER, 'task-1');

    expect(prismaMock.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'task-1' },
        data: { deletedAt: null },
      }),
    );
  });

  it('rejects restoring a task that is not archived (409)', async () => {
    prismaMock.task.findUnique.mockResolvedValue(activeTask);
    await expect(service.restore(OWNER, 'task-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('paginates active tasks and computes meta', async () => {
    prismaMock.$transaction.mockResolvedValue([3, [activeTask]]);
    const result = await service.findAll(OWNER, { page: 1, limit: 2 });
    expect(result.meta).toEqual({ total: 3, page: 1, limit: 2, totalPages: 2 });
    expect(result.data).toHaveLength(1);
  });
});
