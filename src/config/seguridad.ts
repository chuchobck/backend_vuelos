import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { CODIGO_SIN_EQUIVALENTE } from '../common/errores/codigo-error';
import { ErrorNegocio } from '../common/errores/error-negocio';
import { listarOrigenes } from './origenes-cors';

/** Tope del cuerpo de una petición (JSON y formularios). Más grande responde 413. */
export const LIMITE_CUERPO = '100kb';

/** Cabeceras que un navegador puede enviar a esta API desde un origen permitido. */
const CABECERAS_PERMITIDAS = [
  'Authorization',
  'Content-Type',
  'Idempotency-Key',
  'X-Device-Fingerprint',
  'X-Request-Id',
];

/** Cabeceras de la respuesta que el navegador deja leer al código del origen permitido. */
const CABECERAS_EXPUESTAS = [
  'X-Request-Id',
  'Retry-After',
  'X-RateLimit-Limit',
  'X-RateLimit-Remaining',
  'X-RateLimit-Reset',
];

/**
 * Seguridad HTTP de la app: helmet, CORS por lista de orígenes y tope del cuerpo.
 * Va antes de las rutas; los errores que genere (413, por ejemplo) los da el filtro global.
 */
export function configurarSeguridad(app: NestExpressApplication): void {
  const config = app.get(ConfigService);
  const enProduccion = config.get<string>('NODE_ENV') === 'production';

  // Helmet con su política por defecto. Swagger UI en /api/docs funciona con ella: carga
  // su script y su CSS desde la misma ruta y el ícono viene como data URI (img-src data:).
  // `upgrade-insecure-requests` solo se deja en producción: en http://localhost el navegador
  // subiría los recursos a https y Swagger UI no cargaría.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: enProduccion ? {} : { 'upgrade-insecure-requests': null },
      },
    }),
  );

  // Una lista vacía no deja pasar ningún origen: sin CORS_ORIGINS la API no es llamable
  // desde un navegador de otro origen. No se usan cookies, así que no hay `credentials`.
  app.enableCors({
    origin: listarOrigenes(config.get<string>('CORS_ORIGINS')),
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: CABECERAS_PERMITIDAS,
    exposedHeaders: CABECERAS_EXPUESTAS,
    maxAge: 600,
  });

  app.useBodyParser('json', { limit: LIMITE_CUERPO });
  app.useBodyParser('urlencoded', { limit: LIMITE_CUERPO, extended: true });
  // Después de los parsers: un formulario de más de 100 kB sigue siendo 413
  app.use(exigirJson);
}

const METODOS_CON_CUERPO = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Toda operación con cuerpo recibe JSON: un cuerpo de otro tipo (texto, XML, formulario,
 * multipart) o sin Content-Type responde 415 en lugar de llegar vacío a la validación (que lo
 * contestaba con un 400 confuso). Una petición sin cuerpo (POST .../check-in) no se mira.
 */
export function exigirJson(req: Request, _res: Response, next: NextFunction): void {
  const tieneCuerpo =
    Number(req.headers['content-length'] ?? 0) > 0 ||
    req.headers['transfer-encoding'] !== undefined;
  if (!METODOS_CON_CUERPO.has(req.method) || !tieneCuerpo) return next();
  const tipo = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  // Solo application/json: es lo único que lee el parser (un +json llegaría vacío)
  if (tipo === 'application/json') return next();
  next(new ErrorNegocio(415, CODIGO_SIN_EQUIVALENTE, 'Content-Type must be application/json'));
}
