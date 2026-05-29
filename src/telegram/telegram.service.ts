import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf, Context } from 'telegraf';
import { AuthService } from '../auth/auth.service';
import { TasksService } from '../tasks/tasks.service';
import { TaskStatus } from '@prisma/client';

interface SessionData {
  userId?: string;
  email?: string;
}

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private bot: Telegraf | null = null;
  private readonly sessions = new Map<number, SessionData>();

  constructor(
    private readonly config: ConfigService,
    private readonly authService: AuthService,
    private readonly tasksService: TasksService,
  ) {}

  async onModuleInit(): Promise<void> {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) {
      this.logger.warn('TELEGRAM_BOT_TOKEN not set, bot disabled');
      return;
    }

    this.bot = new Telegraf(token);
    this.setupCommands();
    await this.bot.launch();
    this.logger.log('Telegram bot started');
  }

  async onModuleDestroy(): Promise<void> {
    this.bot?.stop();
  }

  private getSession(chatId: number): SessionData {
    if (!this.sessions.has(chatId)) {
      this.sessions.set(chatId, {});
    }
    return this.sessions.get(chatId)!;
  }

  private setupCommands(): void {
    if (!this.bot) return;

    this.bot.command('start', (ctx) => this.handleStart(ctx));
    this.bot.command('register', (ctx) => this.handleRegister(ctx));
    this.bot.command('login', (ctx) => this.handleLogin(ctx));
    this.bot.command('logout', (ctx) => this.handleLogout(ctx));
    this.bot.command('add', (ctx) => this.handleAdd(ctx));
    this.bot.command('list', (ctx) => this.handleList(ctx));
    this.bot.command('done', (ctx) => this.handleDone(ctx));
    this.bot.command('progress', (ctx) => this.handleProgress(ctx));
    this.bot.command('delete', (ctx) => this.handleDelete(ctx));
    this.bot.command('archive', (ctx) => this.handleArchive(ctx));
    this.bot.command('restore', (ctx) => this.handleRestore(ctx));
    this.bot.command('help', (ctx) => this.handleStart(ctx));
  }

  private async handleStart(ctx: Context): Promise<void> {
    const session = this.getSession(ctx.chat!.id);
    const status = session.userId
      ? `Вы авторизованы как ${session.email}`
      : 'Вы не авторизованы';

    await ctx.reply(
      `To-Do Bot\n\n${status}\n\n` +
      'Команды:\n' +
      '/register email password — регистрация\n' +
      '/login email password — вход\n' +
      '/logout — выход\n' +
      '/add текст задачи — создать задачу\n' +
      '/list [todo|in_progress|done] — список задач\n' +
      '/done id — отметить выполненной\n' +
      '/progress id — в работу\n' +
      '/delete id — архивировать\n' +
      '/archive — показать архив\n' +
      '/restore id — восстановить из архива',
    );
  }

  private async handleRegister(ctx: Context): Promise<void> {
    const args = this.parseArgs(ctx);
    if (args.length < 2) {
      await ctx.reply('Формат: /register email password');
      return;
    }

    const [email, password] = args;
    try {
      const result = await this.authService.register({ email, password });
      const session = this.getSession(ctx.chat!.id);
      session.userId = result.user.id;
      session.email = result.user.email;
      await ctx.reply(`Регистрация успешна! Вы вошли как ${email}`);
    } catch (e: any) {
      await ctx.reply(`Ошибка: ${e.message}`);
    }
  }

  private async handleLogin(ctx: Context): Promise<void> {
    const args = this.parseArgs(ctx);
    if (args.length < 2) {
      await ctx.reply('Формат: /login email password');
      return;
    }

    const [email, password] = args;
    try {
      const result = await this.authService.login({ email, password });
      const session = this.getSession(ctx.chat!.id);
      session.userId = result.user.id;
      session.email = result.user.email;
      await ctx.reply(`Вы вошли как ${email}`);
    } catch (e: any) {
      await ctx.reply(`Ошибка: ${e.message}`);
    }
  }

  private async handleLogout(ctx: Context): Promise<void> {
    this.sessions.delete(ctx.chat!.id);
    await ctx.reply('Вы вышли из аккаунта');
  }

  private async handleAdd(ctx: Context): Promise<void> {
    const session = this.getSession(ctx.chat!.id);
    if (!session.userId) {
      await ctx.reply('Сначала авторизуйтесь: /login или /register');
      return;
    }

    const title = this.parseArgs(ctx).join(' ');
    if (!title) {
      await ctx.reply('Формат: /add текст задачи');
      return;
    }

    try {
      const task = await this.tasksService.create(session.userId, { title });
      await ctx.reply(`Задача создана!\nID: ${task.id}\nНазвание: ${task.title}`);
    } catch (e: any) {
      await ctx.reply(`Ошибка: ${e.message}`);
    }
  }

  private async handleList(ctx: Context): Promise<void> {
    const session = this.getSession(ctx.chat!.id);
    if (!session.userId) {
      await ctx.reply('Сначала авторизуйтесь: /login или /register');
      return;
    }

    const args = this.parseArgs(ctx);
    const status = args[0] as TaskStatus | undefined;

    if (status && !Object.values(TaskStatus).includes(status)) {
      await ctx.reply('Статус: todo, in_progress или done');
      return;
    }

    try {
      const result = await this.tasksService.findAll(session.userId, {
        status,
        page: 1,
        limit: 20,
      });

      if (result.data.length === 0) {
        await ctx.reply('Задач нет');
        return;
      }

      const statusEmoji: Record<string, string> = {
        todo: '⬜',
        in_progress: '🔄',
        done: '✅',
      };

      const lines = result.data.map(
        (t) => `${statusEmoji[t.status] || ''} ${t.title}\nID: ${t.id}`,
      );

      await ctx.reply(
        `Задачи (${result.meta.total}):\n\n${lines.join('\n\n')}`,
      );
    } catch (e: any) {
      await ctx.reply(`Ошибка: ${e.message}`);
    }
  }

  private async handleDone(ctx: Context): Promise<void> {
    await this.updateStatus(ctx, TaskStatus.done);
  }

  private async handleProgress(ctx: Context): Promise<void> {
    await this.updateStatus(ctx, TaskStatus.in_progress);
  }

  private async updateStatus(ctx: Context, status: TaskStatus): Promise<void> {
    const session = this.getSession(ctx.chat!.id);
    if (!session.userId) {
      await ctx.reply('Сначала авторизуйтесь: /login или /register');
      return;
    }

    const args = this.parseArgs(ctx);
    if (!args[0]) {
      await ctx.reply('Укажите ID задачи');
      return;
    }

    try {
      const task = await this.tasksService.update(session.userId, args[0], { status });
      const label = status === TaskStatus.done ? 'выполнена' : 'в работе';
      await ctx.reply(`Задача "${task.title}" — ${label}`);
    } catch (e: any) {
      await ctx.reply(`Ошибка: ${e.message}`);
    }
  }

  private async handleDelete(ctx: Context): Promise<void> {
    const session = this.getSession(ctx.chat!.id);
    if (!session.userId) {
      await ctx.reply('Сначала авторизуйтесь: /login или /register');
      return;
    }

    const args = this.parseArgs(ctx);
    if (!args[0]) {
      await ctx.reply('Укажите ID задачи');
      return;
    }

    try {
      const task = await this.tasksService.archive(session.userId, args[0]);
      await ctx.reply(`Задача "${task.title}" перемещена в архив`);
    } catch (e: any) {
      await ctx.reply(`Ошибка: ${e.message}`);
    }
  }

  private async handleArchive(ctx: Context): Promise<void> {
    const session = this.getSession(ctx.chat!.id);
    if (!session.userId) {
      await ctx.reply('Сначала авторизуйтесь: /login или /register');
      return;
    }

    try {
      const result = await this.tasksService.findArchived(session.userId, {
        page: 1,
        limit: 20,
      });

      if (result.data.length === 0) {
        await ctx.reply('Архив пуст');
        return;
      }

      const lines = result.data.map(
        (t) => `🗑 ${t.title}\nID: ${t.id}\nУдалена: ${t.deletedAt?.toLocaleDateString()}`,
      );

      await ctx.reply(`Архив (${result.meta.total}):\n\n${lines.join('\n\n')}`);
    } catch (e: any) {
      await ctx.reply(`Ошибка: ${e.message}`);
    }
  }

  private async handleRestore(ctx: Context): Promise<void> {
    const session = this.getSession(ctx.chat!.id);
    if (!session.userId) {
      await ctx.reply('Сначала авторизуйтесь: /login или /register');
      return;
    }

    const args = this.parseArgs(ctx);
    if (!args[0]) {
      await ctx.reply('Укажите ID задачи');
      return;
    }

    try {
      const task = await this.tasksService.restore(session.userId, args[0]);
      await ctx.reply(`Задача "${task.title}" восстановлена из архива`);
    } catch (e: any) {
      await ctx.reply(`Ошибка: ${e.message}`);
    }
  }

  private parseArgs(ctx: Context): string[] {
    const text = (ctx.message as any)?.text || '';
    const parts = text.split(/\s+/);
    return parts.slice(1);
  }
}
