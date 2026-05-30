import { Module } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { TasksController } from './tasks.controller';
import { TasksCleanupService } from './tasks-cleanup.service';

@Module({
  controllers: [TasksController],
  providers: [TasksService, TasksCleanupService],
  exports: [TasksService],
})
export class TasksModule {}