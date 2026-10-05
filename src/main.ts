import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configurarApp } from './configurar-app';
import { habilitarBigIntEnJson } from './prisma/serializacion-bigint';

async function bootstrap() {
  habilitarBigIntEnJson();

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configurarApp(app);

  await app.listen(app.get(ConfigService).getOrThrow<number>('PORT'));
}
bootstrap();
