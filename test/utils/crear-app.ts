import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { configurarApp } from '../../src/configurar-app';
import { habilitarBigIntEnJson } from '../../src/prisma/serializacion-bigint';

/**
 * Levanta la API completa, con la misma configuración que `main.ts` y la base del `.env`.
 * Las pruebas e2e necesitan PostgreSQL arriba (`docker compose up -d`).
 */
export async function crearApp(): Promise<INestApplication> {
  habilitarBigIntEnJson();

  const modulo = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = modulo.createNestApplication();
  configurarApp(app);
  await app.init();
  return app;
}
