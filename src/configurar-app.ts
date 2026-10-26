import { RequestMethod, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { middlewareContexto, middlewareRequestId } from './common/contexto/contexto.middleware';
import { LoggerPorPeticion } from './common/logger/logger-por-peticion';
import { crearPipeValidacion } from './common/pipes/validacion.pipe';
import { parsearTrustProxy } from './config/proxy';
import { configurarSeguridad } from './config/seguridad';
import { configurarSwagger, configurarSwaggerV2, RUTA_SWAGGER } from './config/swagger';
import { FachadaV2Module } from './modules/vuelos/v2/v2.module';
import {
  PREFIJO_GLOBAL,
  RUTAS_FUERA_DEL_PREFIJO,
  VERSION_POR_DEFECTO,
} from './routes/index.routes';

/**
 * Todo lo que se configura sobre la app de Nest además de sus módulos. Lo usan `main.ts` y
 * las pruebas e2e, para que probar la API sea probar la que de verdad se despliega.
 *
 * El orden de los middlewares importa:
 *   1. request id: antes que todo, para que hasta un 413 del parser lleve X-Request-Id
 *   2. helmet, CORS y parser del cuerpo (configurarSeguridad)
 *   3. contexto asíncrono: después del parser, que perdería el contexto si se abriera antes
 */
export function configurarApp(app: NestExpressApplication): void {
  // Antes del primer middleware: de esto depende que `req.ip` sea la IP del cliente
  app.set('trust proxy', parsearTrustProxy(app.get(ConfigService).get<string>('TRUST_PROXY')));

  app.useLogger(new LoggerPorPeticion());
  app.use(middlewareRequestId);
  configurarSeguridad(app);
  app.use(middlewareContexto);

  // /flights/v1/...: prefijo global más versión en la URL. La fachada v2 (/api/v2/vuelos) no
  // lleva ni lo uno ni lo otro.
  app.setGlobalPrefix(PREFIJO_GLOBAL, {
    exclude: RUTAS_FUERA_DEL_PREFIJO.map((path) => ({ path, method: RequestMethod.ALL })),
  });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: VERSION_POR_DEFECTO });

  app.useGlobalPipes(crearPipeValidacion());

  // La raíz no es una ruta de la API: lleva a la documentación (antes era un 404)
  app
    .getHttpAdapter()
    .get('/', (_req: unknown, res: { redirect: (c: number, u: string) => void }) =>
      res.redirect(302, `/${RUTA_SWAGGER}`),
    );
  // Dos documentos: el de v1 (/api/docs) y el de la fachada v2 (/api/v2/docs)
  configurarSwagger(app, [FachadaV2Module]);
  configurarSwaggerV2(app, FachadaV2Module);
}
