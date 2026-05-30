import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf, Context, Markup } from 'telegraf';
import Redis from 'ioredis';
import { AuthService } from '../auth/auth.service';
import { TasksService } from '../tasks/tasks.service';
import { TaskStatus } from '@prisma/client';

type WaitingFor =
  | 'register_email'
  | 'register_password'
  | 'login_email'
  | 'login_password'
  | 'add_title'
  | 'add_description'
  | 'edit_title'
  | 'edit_description';

interface SessionData {
  userId?: string;
  email?: string;
  waitingFor?: WaitingFor;
  tempEmail?: string;
  tempTitle?: string;
  editingTaskId?: string;
}

const STATUS_EMOJI: Record<string, string> = {
  todo: '⬜',
  in_progress: '🔄',
  done: '✅',
};

const SESSION_TTL = 60 * 60 * 24 * 7;

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private bot: Telegraf | null = null;
  private redis: Redis | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly authService: AuthService,
    private readonly tasksService: TasksService,
  ) {}

  onModuleInit(): void {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) {
      this.logger.warn('TELEGRAM_BOT_TOKEN not set, bot disabled');
      return;
    }

    this.redis = new Redis({
      host: this.config.get('REDIS_HOST', 'localhost'),
      port: Number(this.config.get('REDIS_PORT', 6379)),
      keyPrefix: 'tg:session:',
    });

    this.bot = new Telegraf(token);
    this.setupHandlers();
    this.bot.launch()
      .then(() => this.logger.log('Telegram bot started'))
      .catch((err) => this.logger.error(`Telegram bot failed to start: ${err.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    this.bot?.stop();
    this.redis?.disconnect();
  }

  private async getSession(chatId: number): Promise<SessionData> {
    const raw = await this.redis?.get(String(chatId));
    return raw ? JSON.parse(raw) : {};
  }

  private async saveSession(chatId: number, session: SessionData): Promise<void> {
    await this.redis?.set(String(chatId), JSON.stringify(session), 'EX', SESSION_TTL);
  }

  private async deleteSession(chatId: number): Promise<void> {
    await this.redis?.del(String(chatId));
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
    this.bot.action(/^edit_title:(.+)$/, (ctx) => this.startEditTitle(ctx));
    this.bot.action(/^edit_desc:(.+)$/, (ctx) => this.startEditDescription(ctx));
    this.bot.action(/^view:(.+)$/, (ctx) => this.handleViewTask(ctx));

    this.bot.on('text', (ctx) => this.handleText(ctx));
  }

  private async handleStart(ctx: Context): Promise<void> {
    const session = await this.getSession(ctx.chat!.id);
    session.waitingFor = undefined;
    await this.saveSession(ctx.chat!.id, session);

    await ctx.reply(
      '👋 Привет! Я бот для управления задачами.\n\nВыберите действие:',
      this.mainMenu(!!session.userId),
    );
  }

  private async startRegister(ctx: Context): Promise<void> {
    const session = await this.getSession(ctx.chat!.id);
    session.waitingFor = 'register_email';
    await this.saveSession(ctx.chat!.id, session);
    await ctx.reply('📧 Введите ваш email:', Markup.forceReply());
  }

  private async startLogin(ctx: Context): Promise<void> {
    const session = await this.getSession(ctx.chat!.id);
    session.waitingFor = 'login_email';
    await this.saveSession(ctx.chat!.id, session);
    await ctx.reply('📧 Введите ваш email:', Markup.forceReply());
  }

  private async handleLogout(ctx: Context): Promise<void> {
    await this.deleteSession(ctx.chat!.id);
    await ctx.reply('👋 Вы вышли из аккаунта', this.mainMenu(false));
  }

  private async startAddTask(ctx: Context): Promise<void> {
    const session = await this.getSession(ctx.chat!.id);
    if (!session.userId) {
      await ctx.reply('Сначала авторизуйтесь', this.mainMenu(false));
      return;
    }
    session.waitingFor = 'add_title';
    await this.saveSession(ctx.chat!.id, session);
    await ctx.reply('📝 Введите название задачи:', Markup.forceReply());
  }

  private async handleText(ctx: Context): Promise<void> {
    const text = (ctx.message as any)?.text;
    if (!text) return;

    const session = await this.getSession(ctx.chat!.id);

    switch (session.waitingFor) {
      case 'register_email':
        session.tempEmail = text.trim();
        session.waitingFor = 'register_password';
        await this.saveSession(ctx.chat!.id, session);
        await ctx.reply('🔑 Введите пароль (мин. 8 символов):', Markup.forceReply());
        return;

      case 'register_password':
        await this.finishRegister(ctx, session, text.trim());
        return;

      case 'login_email':
        session.tempEmail = text.trim();
        session.waitingFor = 'login_password';
        await this.saveSession(ctx.chat!.id, session);
        await ctx.reply('🔑 Введите пароль:', Markup.forceReply());
        return;

      case 'login_password':
        await this.finishLogin(ctx, session, text.trim());
        return;

      case 'add_title':
        await this.handleAddTitle(ctx, session, text.trim());
        return;

      case 'add_description':
        await this.finishAddTask(ctx, session, text.trim());
        return;

      case 'edit_title':
        await this.finishEditTitle(ctx, session, text.trim());
        return;

      case 'edit_description':
        await this.finishEditDescription(ctx, session, text.trim());
        return;
    }
  }

  private async finishRegister(ctx: Context, session: SessionData, password: string): Promise<void> {
    const email = session.tempEmail!;

    try {
      const result = await this.authService.register({ email, password });
      await this.saveSession(ctx.chat!.id, { userId: result.user.id, email: result.user.email });
      await ctx.reply(
        `✅ Регистрация успешна!\n\nВы вошли как ${email}`,
        this.mainMenu(true),
      );
    } catch (e: any) {
      await this.saveSession(ctx.chat!.id, {});
      await ctx.reply(`❌ ${e.message}`, this.mainMenu(false));
    }
  }

  private async finishLogin(ctx: Context, session: SessionData, password: string): Promise<void> {
    const email = session.tempEmail!;

    try {
      const result = await this.authService.login({ email, password });
      await this.saveSession(ctx.chat!.id, { userId: result.user.id, email: result.user.email });
      await ctx.reply(
        `✅ Вы вошли как ${email}`,
        this.mainMenu(true),
      );
    } catch (e: any) {
      await this.saveSession(ctx.chat!.id, {});
      await ctx.reply(`❌ ${e.message}`, this.mainMenu(false));
    }
  }

  private async handleAddTitle(ctx: Context, session: SessionData, title: string): Promise<void> {
    if (!title) {
      await ctx.reply('Название не может быть пустым', this.mainMenu(true));
      session.waitingFor = undefined;
      await this.saveSession(ctx.chat!.id, session);
      return;
    }

    session.tempTitle = title;
    session.waitingFor = 'add_description';
    await this.saveSession(ctx.chat!.id, session);
    await ctx.reply(
      '📄 Введите описание задачи (или отправьте «-» чтобы пропустить):',
      Markup.forceReply(),
    );
  }

  private async finishAddTask(ctx: Context, session: SessionData, descriptionInput: string): Promise<void> {
    const title = session.tempTitle!;
    const description = descriptionInput === '-' ? undefined : descriptionInput || undefined;

    session.waitingFor = undefined;
    session.tempTitle = undefined;
    await this.saveSession(ctx.chat!.id, session);

    try {
      const task = await this.tasksService.create(session.userId!, { title, description });
      const descLine = task.description ? `\n📄 ${task.description}` : '';
      await ctx.reply(
        `✅ Задача создана!\n\n⬜ ${task.title}${descLine}`,
        this.mainMenu(true),
      );
    } catch (e: any) {
      await ctx.reply(`❌ ${e.message}`, this.mainMenu(true));
    }
  }

  private async handleList(ctx: Context, status?: TaskStatus): Promise<void> {
    const session = await this.getSession(ctx.chat!.id);
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
        const statusButtons = [];

        if (task.status !== TaskStatus.done) {
          statusButtons.push(Markup.button.callback('✅ Готово', `status:done:${task.id}`));
        }
        if (task.status !== TaskStatus.in_progress) {
          statusButtons.push(Markup.button.callback('🔄 В работу', `status:in_progress:${task.id}`));
        }
        if (task.status !== TaskStatus.todo) {
          statusButtons.push(Markup.button.callback('⬜ Todo', `status:todo:${task.id}`));
        }

        const actionButtons = [
          Markup.button.callback('✏️ Ред.', `view:${task.id}`),
          Markup.button.callback('🗑 Удалить', `archive:${task.id}`),
        ];

        const descLine = task.description ? `\n📄 ${task.description}` : '';

        await ctx.reply(
          `${STATUS_EMOJI[task.status]} ${task.title}${descLine}`,
          Markup.inlineKeyboard([statusButtons, actionButtons]),
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
    const session = await this.getSession(ctx.chat!.id);
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
        const descLine = task.description ? `\n📄 ${task.description}` : '';
        await ctx.reply(
          `🗑 ${task.title}${descLine}\nУдалена: ${task.deletedAt?.toLocaleDateString()}`,
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

  private async handleViewTask(ctx: any): Promise<void> {
    const session = await this.getSession(ctx.chat!.id);
    if (!session.userId) return;

    const taskId = ctx.match[1];

    try {
      const task = await this.tasksService.findOne(session.userId, taskId);
      const descLine = task.description ? `\n📄 ${task.description}` : '\n📄 (нет описания)';

      await ctx.answerCbQuery();
      await ctx.reply(
        `${STATUS_EMOJI[task.status]} *${this.escapeMarkdown(task.title)}*${descLine}\n\nВыберите что редактировать:`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('✏️ Название', `edit_title:${task.id}`),
              Markup.button.callback('📄 Описание', `edit_desc:${task.id}`),
            ],
          ]),
        },
      );
    } catch (e: any) {
      await ctx.answerCbQuery(`Ошибка: ${e.message}`);
    }
  }

  private async startEditTitle(ctx: any): Promise<void> {
    const session = await this.getSession(ctx.chat!.id);
    if (!session.userId) return;

    const taskId = ctx.match[1];
    session.waitingFor = 'edit_title';
    session.editingTaskId = taskId;
    await this.saveSession(ctx.chat!.id, session);

    await ctx.answerCbQuery();
    await ctx.reply('✏️ Введите новое название:', Markup.forceReply());
  }

  private async startEditDescription(ctx: any): Promise<void> {
    const session = await this.getSession(ctx.chat!.id);
    if (!session.userId) return;

    const taskId = ctx.match[1];
    session.waitingFor = 'edit_description';
    session.editingTaskId = taskId;
    await this.saveSession(ctx.chat!.id, session);

    await ctx.answerCbQuery();
    await ctx.reply(
      '📄 Введите новое описание (или «-» чтобы удалить):',
      Markup.forceReply(),
    );
  }

  private async finishEditTitle(ctx: Context, session: SessionData, title: string): Promise<void> {
    const taskId = session.editingTaskId!;
    session.waitingFor = undefined;
    session.editingTaskId = undefined;
    await this.saveSession(ctx.chat!.id, session);

    if (!title) {
      await ctx.reply('Название не может быть пустым', this.mainMenu(true));
      return;
    }

    try {
      const task = await this.tasksService.update(session.userId!, taskId, { title });
      const descLine = task.description ? `\n📄 ${task.description}` : '';
      await ctx.reply(
        `✅ Название обновлено!\n\n${STATUS_EMOJI[task.status]} ${task.title}${descLine}`,
        this.mainMenu(true),
      );
    } catch (e: any) {
      await ctx.reply(`❌ ${e.message}`, this.mainMenu(true));
    }
  }

  private async finishEditDescription(ctx: Context, session: SessionData, descriptionInput: string): Promise<void> {
    const taskId = session.editingTaskId!;
    session.waitingFor = undefined;
    session.editingTaskId = undefined;
    await this.saveSession(ctx.chat!.id, session);

    const description = descriptionInput === '-' ? null : descriptionInput;

    try {
      const task = await this.tasksService.update(session.userId!, taskId, {
        description: description as any,
      });
      const descLine = task.description ? `\n📄 ${task.description}` : '';
      await ctx.reply(
        `✅ Описание обновлено!\n\n${STATUS_EMOJI[task.status]} ${task.title}${descLine}`,
        this.mainMenu(true),
      );
    } catch (e: any) {
      await ctx.reply(`❌ ${e.message}`, this.mainMenu(true));
    }
  }

  private escapeMarkdown(text: string): string {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
  }

  private async handleStatusAction(ctx: any): Promise<void> {
    const session = await this.getSession(ctx.chat!.id);
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
    const session = await this.getSession(ctx.chat!.id);
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
    const session = await this.getSession(ctx.chat!.id);
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