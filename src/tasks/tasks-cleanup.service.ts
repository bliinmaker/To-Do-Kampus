import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Queue, Worker } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';

interface CleanupJobData {
  taskId: string;
}

@Injectable()
export class TasksCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TasksCleanupService.name);
  private readonly retentionMs: number;
  private queue!: Queue<CleanupJobData>;
  private worker!: Worker<CleanupJobData>;
  private readonly redisConnection: { host: string; port: number };

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    const days = Number(config.get('ARCHIVE_RETENTION_DAYS', 7));
    this.retentionMs = days * 24 * 60 * 60 * 1000;
    this.redisConnection = {
      host: config.get('REDIS_HOST', 'localhost'),
      port: Number(config.get('REDIS_PORT', 6379)),
    };
  }

  onModuleInit(): void {
    this.queue = new Queue<CleanupJobData>('task-cleanup', {
      connection: this.redisConnection,
    });

    this.worker = new Worker<CleanupJobData>(
      'task-cleanup',
      async (job) => {
        const task = await this.prisma.task.findUnique({
          where: { id: job.data.taskId },
        });

        if (!task || !task.deletedAt) return;

        await this.prisma.task.delete({ where: { id: job.data.taskId } });
        this.logger.log(`Permanently deleted task ${job.data.taskId}`);
      },
      { connection: this.redisConnection },
    );

    this.worker.on('failed', (job, err) => {
      this.logger.error(`Cleanup job ${job?.id} failed: ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }

  async scheduleCleanup(taskId: string): Promise<void> {
    await this.queue.add('delete-task', { taskId }, {
      delay: this.retentionMs,
      jobId: `cleanup:${taskId}`,
      removeOnComplete: true,
      removeOnFail: false,
    });
  }

  async cancelCleanup(taskId: string): Promise<void> {
    const job = await this.queue.getJob(`cleanup:${taskId}`);
    if (job) await job.remove();
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