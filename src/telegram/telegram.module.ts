import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TasksModule } from '../tasks/tasks.module';
import { TelegramService } from './telegram.service';

@Module({
  imports: [AuthModule, TasksModule],
  providers: [TelegramService],
})
export class TelegramModule {}
