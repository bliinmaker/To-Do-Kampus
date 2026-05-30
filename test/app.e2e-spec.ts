import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('To-Do API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let accessToken: string;
  let secondToken: string;
  let taskId: string;

  const testUser = {
    email: `e2e-${Date.now()}@test.com`,
    password: 'TestPass123',
  };
  const secondUser = {
    email: `e2e-other-${Date.now()}@test.com`,
    password: 'TestPass456',
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();

    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    // clean up test data
    await prisma.task.deleteMany({
      where: {
        user: { email: { in: [testUser.email, secondUser.email] } },
      },
    });
    await prisma.user.deleteMany({
      where: { email: { in: [testUser.email, secondUser.email] } },
    });
    await app.close();
  });

  // ─── AUTH ────────────────────────────────────────────────────

  describe('POST /auth/register', () => {
    it('201 — registers a new user', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/register')
        .send(testUser)
        .expect(201);

      expect(res.body).toHaveProperty('accessToken');
      expect(res.body.user.email).toBe(testUser.email);
      accessToken = res.body.accessToken;
    });

    it('409 — rejects duplicate email', () => {
      return request(app.getHttpServer())
        .post('/auth/register')
        .send(testUser)
        .expect(409);
    });

    it('400 — rejects invalid email', () => {
      return request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: 'not-email', password: 'TestPass123' })
        .expect(400);
    });

    it('400 — rejects short password', () => {
      return request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: 'short@test.com', password: '123' })
        .expect(400);
    });
  });

  describe('POST /auth/login', () => {
    it('200 — logs in with valid credentials', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send(testUser)
        .expect(200);

      expect(res.body).toHaveProperty('accessToken');
      accessToken = res.body.accessToken;
    });

    it('401 — rejects wrong password', () => {
      return request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: testUser.email, password: 'WrongPass999' })
        .expect(401);
    });

    it('401 — rejects non-existent email', () => {
      return request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'nobody@test.com', password: 'TestPass123' })
        .expect(401);
    });
  });

  // Register second user for ownership tests
  describe('Second user setup', () => {
    it('registers second user', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/register')
        .send(secondUser)
        .expect(201);
      secondToken = res.body.accessToken;
    });
  });

  // ─── TASKS CRUD ──────────────────────────────────────────────

  describe('POST /tasks', () => {
    it('401 — rejects unauthenticated request', () => {
      return request(app.getHttpServer())
        .post('/tasks')
        .send({ title: 'No auth' })
        .expect(401);
    });

    it('201 — creates a task', async () => {
      const res = await request(app.getHttpServer())
        .post('/tasks')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ title: 'E2E task', description: 'test desc' })
        .expect(201);

      expect(res.body.title).toBe('E2E task');
      expect(res.body.status).toBe('todo');
      expect(res.body.deletedAt).toBeNull();
      taskId = res.body.id;
    });

    it('400 — rejects empty title', () => {
      return request(app.getHttpServer())
        .post('/tasks')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ title: '' })
        .expect(400);
    });

    it('400 — rejects unknown fields', () => {
      return request(app.getHttpServer())
        .post('/tasks')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ title: 'ok', hack: true })
        .expect(400);
    });
  });

  describe('GET /tasks', () => {
    it('200 — lists active tasks with pagination', async () => {
      const res = await request(app.getHttpServer())
        .get('/tasks')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('meta');
      expect(res.body.meta.total).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('200 — filters by status', async () => {
      const res = await request(app.getHttpServer())
        .get('/tasks?status=todo')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      for (const task of res.body.data) {
        expect(task.status).toBe('todo');
      }
    });

    it('400 — rejects invalid status', () => {
      return request(app.getHttpServer())
        .get('/tasks?status=invalid')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(400);
    });
  });

  describe('GET /tasks/:id', () => {
    it('200 — returns task by id', async () => {
      const res = await request(app.getHttpServer())
        .get(`/tasks/${taskId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body.id).toBe(taskId);
    });

    it('403 — denies access to another user\'s task', () => {
      return request(app.getHttpServer())
        .get(`/tasks/${taskId}`)
        .set('Authorization', `Bearer ${secondToken}`)
        .expect(403);
    });

    it('404 — returns 404 for non-existent id', () => {
      return request(app.getHttpServer())
        .get('/tasks/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(404);
    });

    it('400 — rejects invalid UUID', () => {
      return request(app.getHttpServer())
        .get('/tasks/not-a-uuid')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(400);
    });
  });

  describe('PATCH /tasks/:id', () => {
    it('200 — updates task title and status', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/tasks/${taskId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ title: 'Updated title', status: 'in_progress' })
        .expect(200);

      expect(res.body.title).toBe('Updated title');
      expect(res.body.status).toBe('in_progress');
    });

    it('403 — denies update to another user\'s task', () => {
      return request(app.getHttpServer())
        .patch(`/tasks/${taskId}`)
        .set('Authorization', `Bearer ${secondToken}`)
        .send({ title: 'Hack' })
        .expect(403);
    });
  });

  // ─── ARCHIVE / RESTORE ──────────────────────────────────────

  describe('DELETE /tasks/:id (archive)', () => {
    it('200 — archives the task (soft delete)', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/tasks/${taskId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body.deletedAt).not.toBeNull();
    });

    it('409 — rejects archiving an already archived task', () => {
      return request(app.getHttpServer())
        .delete(`/tasks/${taskId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(409);
    });
  });

  describe('PATCH /tasks/:id (update archived)', () => {
    it('409 — denies editing an archived task', () => {
      return request(app.getHttpServer())
        .patch(`/tasks/${taskId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ title: 'should fail' })
        .expect(409);
    });
  });

  describe('GET /tasks/archived', () => {
    it('200 — lists archived tasks', async () => {
      const res = await request(app.getHttpServer())
        .get('/tasks/archived')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
      for (const task of res.body.data) {
        expect(task.deletedAt).not.toBeNull();
      }
    });
  });

  describe('PATCH /tasks/:id/restore', () => {
    it('200 — restores an archived task', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/tasks/${taskId}/restore`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body.deletedAt).toBeNull();
    });

    it('409 — rejects restoring a non-archived task', () => {
      return request(app.getHttpServer())
        .patch(`/tasks/${taskId}/restore`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(409);
    });

    it('403 — denies restoring another user\'s task', () => {
      return request(app.getHttpServer())
        .patch(`/tasks/${taskId}/restore`)
        .set('Authorization', `Bearer ${secondToken}`)
        .expect(403);
    });
  });

  // ─── EDGE CASES ──────────────────────────────────────────────

  describe('Second user isolation', () => {
    it('second user sees empty task list', async () => {
      const res = await request(app.getHttpServer())
        .get('/tasks')
        .set('Authorization', `Bearer ${secondToken}`)
        .expect(200);

      expect(res.body.meta.total).toBe(0);
    });
  });
});