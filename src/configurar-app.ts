import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { configurarSwagger } from './config/swagger';
import { PREFIJO_GLOBAL, VERSION_POR_DEFECTO } from './routes/index.routes';

/**
 * Todo lo que se configura sobre la app de Nest además de sus módulos. Lo usan `main.ts` y
 * las pruebas e2e, para que probar la API sea probar la que de verdad se despliega.
 */
export function configurarApp(app: INestApplication): void {
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
}
