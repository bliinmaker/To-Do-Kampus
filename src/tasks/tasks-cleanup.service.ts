import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TasksCleanupService {
  private readonly logger = new Logger(TasksCleanupService.name);
  private readonly retentionMs: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    const days = Number(config.get('ARCHIVE_RETENTION_DAYS', 7));
    this.retentionMs = days * 24 * 60 * 60 * 1000;
  }

  async scheduleCleanup(_taskId: string): Promise<void> {}

  async cancelCleanup(_taskId: string): Promise<void> {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async purgeExpiredTasks(): Promise<number> {
    const cutoff = new Date(Date.now() - this.retentionMs);

    const { count } = await this.prisma.task.deleteMany({
      where: { deletedAt: { lte: cutoff } },
    });

    if (count > 0) {
      this.logger.log(`Deleted ${count} expired archived task(s)`);
    }
    return count;
  }
}