import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configurarApp } from './configurar-app';
import { iniciarGrpc } from './config/grpc';
import { habilitarBigIntEnJson } from './prisma/serializacion-bigint';

async function bootstrap() {
  habilitarBigIntEnJson();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Los logs del arranque esperan a que configurarApp ponga el logger con request id
    bufferLogs: true,
  });
  configurarApp(app);
  // Servidor gRPC interno, solo con GRPC_ENABLED=true (src/config/grpc.ts)
  await iniciarGrpc(app);

  await app.listen(app.get(ConfigService).getOrThrow<number>('PORT'));
}
bootstrap();
