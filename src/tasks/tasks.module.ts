import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TasksService } from './tasks.service';
import { TasksController } from './tasks.controller';
import { TasksCleanupService } from './tasks-cleanup.service';
import { TasksCleanupProcessor, TASK_CLEANUP_QUEUE } from './tasks-cleanup.processor';

@Module({
  imports: [
    BullModule.registerQueue({ name: TASK_CLEANUP_QUEUE }),
  ],
  controllers: [TasksController],
  providers: [TasksService, TasksCleanupService, TasksCleanupProcessor],
  exports: [TasksService],
})
export class TasksModule {}
