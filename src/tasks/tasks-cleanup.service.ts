import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { TASK_CLEANUP_QUEUE, TaskCleanupJobData } from './tasks-cleanup.processor';

@Injectable()
export class TasksCleanupService {
  private readonly logger = new Logger(TasksCleanupService.name);
  private readonly retentionMs: number;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(TASK_CLEANUP_QUEUE) private readonly cleanupQueue: Queue<TaskCleanupJobData>,
    config: ConfigService,
  ) {
    const days = Number(config.get('ARCHIVE_RETENTION_DAYS', 7));
    this.retentionMs = days * 24 * 60 * 60 * 1000;
  }

  async scheduleCleanup(taskId: string): Promise<void> {
    await this.cleanupQueue.add(
      'delete-task',
      { taskId },
      {
        delay: this.retentionMs,
        jobId: `cleanup:${taskId}`,
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  }

  async cancelCleanup(taskId: string): Promise<void> {
    const job = await this.cleanupQueue.getJob(`cleanup:${taskId}`);
    if (job) {
      await job.remove();
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async purgeExpiredTasks(): Promise<number> {
    const cutoff = new Date(Date.now() - this.retentionMs);

    const { count } = await this.prisma.task.deleteMany({
      where: { deletedAt: { lte: cutoff } },
    });

    if (count > 0) {
      this.logger.log(`Fallback cleanup: deleted ${count} expired task(s)`);
    }
    return count;
  }
}
