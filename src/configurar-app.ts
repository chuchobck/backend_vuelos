import { VersioningType } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { crearPipeValidacion } from './common/pipes/validacion.pipe';
import { configurarSeguridad } from './config/seguridad';
import { configurarSwagger } from './config/swagger';
import { PREFIJO_GLOBAL, VERSION_POR_DEFECTO } from './routes/index.routes';

/**
 * Todo lo que se configura sobre la app de Nest además de sus módulos. Lo usan `main.ts` y
 * las pruebas e2e, para que probar la API sea probar la que de verdad se despliega.
 */
export function configurarApp(app: NestExpressApplication): void {
  // helmet, CORS y tope del cuerpo van primero: antes que cualquier ruta
  configurarSeguridad(app);

  // /flights/v1/...: prefijo global más versión en la URL
  app.setGlobalPrefix(PREFIJO_GLOBAL);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: VERSION_POR_DEFECTO });

  app.useGlobalPipes(crearPipeValidacion());

  configurarSwagger(app);
}
