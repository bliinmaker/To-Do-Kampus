import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TasksCleanupService {
  private readonly logger = new Logger(TasksCleanupService.name);
  private readonly retentionDays: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.retentionDays = Number(config.get('ARCHIVE_RETENTION_DAYS', 7));
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async purgeExpiredTasks(): Promise<number> {
    const cutoff = new Date(
      Date.now() - this.retentionDays * 24 * 60 * 60 * 1000,
    );

    const { count } = await this.prisma.task.deleteMany({
      where: { deletedAt: { lte: cutoff } },
    });

    if (count > 0) {
      this.logger.log(`Permanently deleted ${count} expired archived task(s)`);
    }
    return count;
  }
}
