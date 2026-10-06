import { Type } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getStorageToken } from '@nestjs/throttler';
import { AppModule } from '../../src/app.module';
import { Reloj } from '../../src/common/reloj';
import { configurarApp } from '../../src/configurar-app';
import { habilitarBigIntEnJson } from '../../src/prisma/serializacion-bigint';
import { LimitesReiniciables } from './limites';

export interface OpcionesCrearApp {
  /** Deja los logs de Nest encendidos. Por defecto se apagan para no llenar la salida de Jest. */
  logs?: boolean;
  /** Reemplaza el Reloj de la aplicación (por ejemplo, un RelojDePrueba que se adelanta). */
  reloj?: Reloj;
  /** Contadores del límite de peticiones que la prueba puede reiniciar. */
  limites?: LimitesReiniciables;
  /** Otros providers reemplazados (por ejemplo SERVICIO_PAGOS por un pago de prueba). */
  reemplazos?: Array<{ proveedor: unknown; valor: unknown }>;
}

/**
 * Levanta la API completa, con la misma configuración que `main.ts` y la base del `.env`.
 * Las pruebas e2e necesitan PostgreSQL arriba (`docker compose up -d`).
 *
 * `controllersDePrueba` agrega controllers que solo existen en la prueba (por ejemplo uno que
 * lanza un error a propósito); quedan bajo /flights/v1 como cualquier otro.
 */
export async function crearApp(
  controllersDePrueba: Type[] = [],
  opciones: OpcionesCrearApp = {},
): Promise<NestExpressApplication> {
  habilitarBigIntEnJson();

  let constructor = Test.createTestingModule({
    imports: [AppModule],
    controllers: controllersDePrueba,
  });
  if (opciones.reloj) constructor = constructor.overrideProvider(Reloj).useValue(opciones.reloj);
  if (opciones.limites) {
    constructor = constructor.overrideProvider(getStorageToken()).useValue(opciones.limites);
  }
  for (const { proveedor, valor } of opciones.reemplazos ?? []) {
    constructor = constructor.overrideProvider(proveedor).useValue(valor);
  }
  const modulo = await constructor.compile();
  const app = modulo.createNestApplication<NestExpressApplication>();
  configurarApp(app);
  if (!opciones.logs) app.useLogger(false);
  await app.init();
  return app;
}
