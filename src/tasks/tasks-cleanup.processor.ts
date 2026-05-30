import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker, Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';

export const TASK_CLEANUP_QUEUE = 'task-cleanup';

export interface TaskCleanupJobData {
  taskId: string;
}

@Injectable()
export class TasksCleanupProcessor implements OnModuleInit {
  private readonly logger = new Logger(TasksCleanupProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const worker = new Worker<TaskCleanupJobData>(
      TASK_CLEANUP_QUEUE,
      async (job: Job<TaskCleanupJobData>) => {
        const { taskId } = job.data;
        const task = await this.prisma.task.findUnique({ where: { id: taskId } });

        if (!task || !task.deletedAt) {
          return;
        }

        await this.prisma.task.delete({ where: { id: taskId } });
        this.logger.log(`Permanently deleted task ${taskId}`);
      },
      {
        connection: {
          host: this.config.get('REDIS_HOST', 'localhost'),
          port: Number(this.config.get('REDIS_PORT', 6379)),
        },
      },
    );

    worker.on('failed', (job, err) => {
      this.logger.error(`Cleanup job ${job?.id} failed: ${err.message}`);
    });
  }
}