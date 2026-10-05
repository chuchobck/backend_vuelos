import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configurarSwagger } from './config/swagger';
import { habilitarBigIntEnJson } from './prisma/serializacion-bigint';
import { PREFIJO_GLOBAL, VERSION_POR_DEFECTO } from './routes/index.routes';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  habilitarBigIntEnJson();

  const app = await NestFactory.create(AppModule);

  // /flights/v1/...: prefijo global más versión en la URL
  app.setGlobalPrefix(PREFIJO_GLOBAL);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: VERSION_POR_DEFECTO });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  configurarSwagger(app);

  await app.listen(app.get(ConfigService).getOrThrow<number>('PORT'));
}
bootstrap();
