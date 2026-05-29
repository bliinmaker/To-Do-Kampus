import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';

export const TASK_CLEANUP_QUEUE = 'task-cleanup';

export interface TaskCleanupJobData {
  taskId: string;
}

@Processor(TASK_CLEANUP_QUEUE)
export class TasksCleanupProcessor extends WorkerHost {
  private readonly logger = new Logger(TasksCleanupProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<TaskCleanupJobData>): Promise<void> {
    const { taskId } = job.data;

    const task = await this.prisma.task.findUnique({ where: { id: taskId } });

    if (!task || !task.deletedAt) {
      return;
    }

    await this.prisma.task.delete({ where: { id: taskId } });
    this.logger.log(`Permanently deleted task ${taskId}`);
  }
}
