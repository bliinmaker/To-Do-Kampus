import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

const INSECURE_DEFAULTS = ['change-me-to-a-long-random-string', 'replace-with-a-strong-random-string'];

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  const jwtSecret = config.get<string>('JWT_SECRET');
  if (!jwtSecret || INSECURE_DEFAULTS.includes(jwtSecret)) {
    console.warn('⚠  JWT_SECRET is missing or uses a default value. Set a strong random secret before deploying to production.');
  }

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('To-Do API')
    .setDescription('Secure task management REST API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);

  app.enableShutdownHooks();

  const port = Number(config.get('PORT', 3000));
  await app.listen(port);
  console.log(`API running on http://localhost:${port} (docs at /docs)`);
}

void bootstrap();
