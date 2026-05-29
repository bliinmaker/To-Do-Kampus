import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf, Context, Markup } from 'telegraf';
import { AuthService } from '../auth/auth.service';
import { TasksService } from '../tasks/tasks.service';
import { TaskStatus } from '@prisma/client';

type WaitingFor =
  | 'register_email'
  | 'register_password'
  | 'login_email'
  | 'login_password'
  | 'add_title';

interface SessionData {
  userId?: string;
  email?: string;
  waitingFor?: WaitingFor;
  tempEmail?: string;
}

const STATUS_EMOJI: Record<string, string> = {
  todo: '⬜',
  in_progress: '🔄',
  done: '✅',
};

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
    this.setupHandlers();
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

  private mainMenu(loggedIn: boolean) {
    if (!loggedIn) {
      return Markup.keyboard([
        ['🔐 Войти', '📝 Регистрация'],
      ]).resize();
    }

    return Markup.keyboard([
      ['➕ Новая задача', '📋 Мои задачи'],
      ['⬜ Todo', '🔄 В работе', '✅ Готово'],
      ['🗑 Архив', '🚪 Выйти'],
    ]).resize();
  }

  private setupHandlers(): void {
    if (!this.bot) return;

    this.bot.command('start', (ctx) => this.handleStart(ctx));

    this.bot.hears('📝 Регистрация', (ctx) => this.startRegister(ctx));
    this.bot.hears('🔐 Войти', (ctx) => this.startLogin(ctx));
    this.bot.hears('🚪 Выйти', (ctx) => this.handleLogout(ctx));
    this.bot.hears('➕ Новая задача', (ctx) => this.startAddTask(ctx));
    this.bot.hears('📋 Мои задачи', (ctx) => this.handleList(ctx));
    this.bot.hears('⬜ Todo', (ctx) => this.handleListByStatus(ctx, TaskStatus.todo));
    this.bot.hears('🔄 В работе', (ctx) => this.handleListByStatus(ctx, TaskStatus.in_progress));
    this.bot.hears('✅ Готово', (ctx) => this.handleListByStatus(ctx, TaskStatus.done));
    this.bot.hears('🗑 Архив', (ctx) => this.handleArchive(ctx));

    this.bot.action(/^status:(.+):(.+)$/, (ctx) => this.handleStatusAction(ctx));
    this.bot.action(/^archive:(.+)$/, (ctx) => this.handleArchiveAction(ctx));
    this.bot.action(/^restore:(.+)$/, (ctx) => this.handleRestoreAction(ctx));

    this.bot.on('text', (ctx) => this.handleText(ctx));
  }

  private async handleStart(ctx: Context): Promise<void> {
    const session = this.getSession(ctx.chat!.id);
    session.waitingFor = undefined;

    await ctx.reply(
      '👋 Привет! Я бот для управления задачами.\n\nВыберите действие:',
      this.mainMenu(!!session.userId),
    );
  }

  private async startRegister(ctx: Context): Promise<void> {
    const session = this.getSession(ctx.chat!.id);
    session.waitingFor = 'register_email';
    await ctx.reply('📧 Введите ваш email:', Markup.forceReply());
  }

  private async startLogin(ctx: Context): Promise<void> {
    const session = this.getSession(ctx.chat!.id);
    session.waitingFor = 'login_email';
    await ctx.reply('📧 Введите ваш email:', Markup.forceReply());
  }

  private async handleLogout(ctx: Context): Promise<void> {
    this.sessions.delete(ctx.chat!.id);
    await ctx.reply('👋 Вы вышли из аккаунта', this.mainMenu(false));
  }

  private async startAddTask(ctx: Context): Promise<void> {
    const session = this.getSession(ctx.chat!.id);
    if (!session.userId) {
      await ctx.reply('Сначала авторизуйтесь', this.mainMenu(false));
      return;
    }
    session.waitingFor = 'add_title';
    await ctx.reply('📝 Введите название задачи:', Markup.forceReply());
  }

  private async handleText(ctx: Context): Promise<void> {
    const text = (ctx.message as any)?.text;
    if (!text) return;

    const session = this.getSession(ctx.chat!.id);

    switch (session.waitingFor) {
      case 'register_email':
        session.tempEmail = text.trim();
        session.waitingFor = 'register_password';
        await ctx.reply('🔑 Введите пароль (мин. 8 символов):', Markup.forceReply());
        return;

      case 'register_password':
        await this.finishRegister(ctx, session, text.trim());
        return;

      case 'login_email':
        session.tempEmail = text.trim();
        session.waitingFor = 'login_password';
        await ctx.reply('🔑 Введите пароль:', Markup.forceReply());
        return;

      case 'login_password':
        await this.finishLogin(ctx, session, text.trim());
        return;

      case 'add_title':
        await this.finishAddTask(ctx, session, text.trim());
        return;
    }
  }

  private async finishRegister(ctx: Context, session: SessionData, password: string): Promise<void> {
    session.waitingFor = undefined;
    const email = session.tempEmail!;
    session.tempEmail = undefined;

    try {
      const result = await this.authService.register({ email, password });
      session.userId = result.user.id;
      session.email = result.user.email;
      await ctx.reply(
        `✅ Регистрация успешна!\n\nВы вошли как ${email}`,
        this.mainMenu(true),
      );
    } catch (e: any) {
      await ctx.reply(`❌ ${e.message}`, this.mainMenu(false));
    }
  }

  private async finishLogin(ctx: Context, session: SessionData, password: string): Promise<void> {
    session.waitingFor = undefined;
    const email = session.tempEmail!;
    session.tempEmail = undefined;

    try {
      const result = await this.authService.login({ email, password });
      session.userId = result.user.id;
      session.email = result.user.email;
      await ctx.reply(
        `✅ Вы вошли как ${email}`,
        this.mainMenu(true),
      );
    } catch (e: any) {
      await ctx.reply(`❌ ${e.message}`, this.mainMenu(false));
    }
  }

  private async finishAddTask(ctx: Context, session: SessionData, title: string): Promise<void> {
    session.waitingFor = undefined;

    if (!title) {
      await ctx.reply('Название не может быть пустым', this.mainMenu(true));
      return;
    }

    try {
      const task = await this.tasksService.create(session.userId!, { title });
      await ctx.reply(
        `✅ Задача создана!\n\n⬜ ${task.title}`,
        this.mainMenu(true),
      );
    } catch (e: any) {
      await ctx.reply(`❌ ${e.message}`, this.mainMenu(true));
    }
  }

  private async handleList(ctx: Context, status?: TaskStatus): Promise<void> {
    const session = this.getSession(ctx.chat!.id);
    if (!session.userId) {
      await ctx.reply('Сначала авторизуйтесь', this.mainMenu(false));
      return;
    }

    try {
      const result = await this.tasksService.findAll(session.userId, {
        status,
        page: 1,
        limit: 20,
      });

      if (result.data.length === 0) {
        const label = status ? ` со статусом "${status}"` : '';
        await ctx.reply(`📭 Задач${label} нет`, this.mainMenu(true));
        return;
      }

      for (const task of result.data) {
        const buttons = [];

        if (task.status !== TaskStatus.done) {
          buttons.push(Markup.button.callback('✅ Готово', `status:done:${task.id}`));
        }
        if (task.status !== TaskStatus.in_progress) {
          buttons.push(Markup.button.callback('🔄 В работу', `status:in_progress:${task.id}`));
        }
        if (task.status !== TaskStatus.todo) {
          buttons.push(Markup.button.callback('⬜ Todo', `status:todo:${task.id}`));
        }
        buttons.push(Markup.button.callback('🗑 Удалить', `archive:${task.id}`));

        await ctx.reply(
          `${STATUS_EMOJI[task.status]} ${task.title}`,
          Markup.inlineKeyboard(buttons, { columns: 2 }),
        );
      }

      await ctx.reply(
        `Всего: ${result.meta.total}`,
        this.mainMenu(true),
      );
    } catch (e: any) {
      await ctx.reply(`❌ ${e.message}`, this.mainMenu(true));
    }
  }

  private async handleListByStatus(ctx: Context, status: TaskStatus): Promise<void> {
    return this.handleList(ctx, status);
  }

  private async handleArchive(ctx: Context): Promise<void> {
    const session = this.getSession(ctx.chat!.id);
    if (!session.userId) {
      await ctx.reply('Сначала авторизуйтесь', this.mainMenu(false));
      return;
    }

    try {
      const result = await this.tasksService.findArchived(session.userId, {
        page: 1,
        limit: 20,
      });

      if (result.data.length === 0) {
        await ctx.reply('📭 Архив пуст', this.mainMenu(true));
        return;
      }

      for (const task of result.data) {
        await ctx.reply(
          `🗑 ${task.title}\nУдалена: ${task.deletedAt?.toLocaleDateString()}`,
          Markup.inlineKeyboard([
            Markup.button.callback('♻️ Восстановить', `restore:${task.id}`),
          ]),
        );
      }

      await ctx.reply(`Всего в архиве: ${result.meta.total}`, this.mainMenu(true));
    } catch (e: any) {
      await ctx.reply(`❌ ${e.message}`, this.mainMenu(true));
    }
  }

  private async handleStatusAction(ctx: any): Promise<void> {
    const session = this.getSession(ctx.chat!.id);
    if (!session.userId) return;

    const status = ctx.match[1] as TaskStatus;
    const taskId = ctx.match[2];

    try {
      const task = await this.tasksService.update(session.userId, taskId, { status });
      const label = { done: 'выполнена', in_progress: 'в работе', todo: 'todo' }[status];
      await ctx.answerCbQuery(`${task.title} — ${label}`);
      await ctx.editMessageText(`${STATUS_EMOJI[status]} ${task.title} — ${label}`);
    } catch (e: any) {
      await ctx.answerCbQuery(`Ошибка: ${e.message}`);
    }
  }

  private async handleArchiveAction(ctx: any): Promise<void> {
    const session = this.getSession(ctx.chat!.id);
    if (!session.userId) return;

    const taskId = ctx.match[1];

    try {
      const task = await this.tasksService.archive(session.userId, taskId);
      await ctx.answerCbQuery(`${task.title} — в архиве`);
      await ctx.editMessageText(`🗑 ${task.title} — в архиве`);
    } catch (e: any) {
      await ctx.answerCbQuery(`Ошибка: ${e.message}`);
    }
  }

  private async handleRestoreAction(ctx: any): Promise<void> {
    const session = this.getSession(ctx.chat!.id);
    if (!session.userId) return;

    const taskId = ctx.match[1];

    try {
      const task = await this.tasksService.restore(session.userId, taskId);
      await ctx.answerCbQuery(`${task.title} — восстановлена`);
      await ctx.editMessageText(`⬜ ${task.title} — восстановлена`);
    } catch (e: any) {
      await ctx.answerCbQuery(`Ошибка: ${e.message}`);
    }
  }
}