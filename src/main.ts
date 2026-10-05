import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { habilitarBigIntEnJson } from './prisma/serializacion-bigint';
import { PREFIJO_GLOBAL, VERSION_POR_DEFECTO } from './routes/index.routes';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

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

  const config = new DocumentBuilder()
    .setTitle('Booking Prototipo API')
    .setDescription('API base para los dominios de Alojamientos, Autos, Atracciones y Vuelos.')
    .setVersion('1.0')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  await app.listen(app.get(ConfigService).getOrThrow<number>('PORT'));
}
bootstrap();
