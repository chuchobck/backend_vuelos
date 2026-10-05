import { Type } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { configurarApp } from '../../src/configurar-app';
import { habilitarBigIntEnJson } from '../../src/prisma/serializacion-bigint';

/**
 * Levanta la API completa, con la misma configuración que `main.ts` y la base del `.env`.
 * Las pruebas e2e necesitan PostgreSQL arriba (`docker compose up -d`).
 *
 * `controllersDePrueba` agrega controllers que solo existen en la prueba (por ejemplo uno que
 * lanza un error a propósito); quedan bajo /flights/v1 como cualquier otro.
 */
export async function crearApp(controllersDePrueba: Type[] = []): Promise<NestExpressApplication> {
  habilitarBigIntEnJson();

  const modulo = await Test.createTestingModule({
    imports: [AppModule],
    controllers: controllersDePrueba,
  }).compile();
  const app = modulo.createNestApplication<NestExpressApplication>();
  configurarApp(app);
  await app.init();
  return app;
}
