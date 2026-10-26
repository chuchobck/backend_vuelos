import { Logger } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import {
  ContextoPeticion,
  crearContexto,
  ejecutarEnContexto,
  normalizarIp,
} from './contexto-peticion';
import { CABECERA_CORRELACION, resolverCorrelationId } from './correlation-id';
import { CABECERA_REQUEST_ID, resolverRequestId } from './request-id';
import { CONTEXTO_ACCESO, lineaDeAcceso } from '../logger/registro-acceso';

const logger = new Logger('HTTP');
const acceso = new Logger(CONTEXTO_ACCESO);

/** Donde se guarda el contexto en la petición, para quien corre fuera del contexto asíncrono. */
const CONTEXTO_EN_PETICION = Symbol('contextoPeticion');

type PeticionConContexto = Request & { [CONTEXTO_EN_PETICION]?: ContextoPeticion };

/** El contexto que se le asignó a la petición, aunque se lea fuera de `ejecutarEnContexto`. */
export function contextoDeLaPeticion(peticion: Request): ContextoPeticion | undefined {
  return (peticion as PeticionConContexto)[CONTEXTO_EN_PETICION];
}

/**
 * Primer middleware de la app. Asigna el X-Request-Id y el X-Correlation-Id y los devuelve en la
 * respuesta; como va antes que helmet, CORS y el parser del cuerpo, también los llevan los
 * errores que esos producen (413, JSON roto). Al terminar la respuesta deja dos líneas de log,
 * la de texto de siempre y la de acceso en JSON (registro-acceso.ts):
 *
 *   LOG [HTTP] [8d1f...] POST /flights/v1/offers/hold 201 48.3ms ip=10.0.0.7 user=<sub> client=<client_id> [corr=...]
 *   {"timestamp":"...","service":"core-vuelos","correlation_id":"...","request_id":"8d1f...",...}
 *
 * `user` solo con un token válido y `client` solo si el token es de un cliente máquina a máquina.
 */
export function middlewareRequestId(peticion: Request, respuesta: Response, next: NextFunction) {
  const contexto = crearContexto({
    requestId: resolverRequestId(peticion.headers['x-request-id']),
    correlationId: resolverCorrelationId(peticion.headers['x-correlation-id']),
    ip: normalizarIp(peticion.ip),
  });
  (peticion as PeticionConContexto)[CONTEXTO_EN_PETICION] = contexto;
  respuesta.setHeader(CABECERA_REQUEST_ID, contexto.requestId);
  respuesta.setHeader(CABECERA_CORRELACION, contexto.correlationId);

  const inicio = process.hrtime.bigint();
  respuesta.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - inicio) / 1e6;
    // 'finish' se emite desde el socket, fuera del contexto asíncrono de la petición:
    // se vuelve a entrar para que el logger vea el id.
    ejecutarEnContexto(contexto, () => {
      logger.log(
        `${peticion.method} ${peticion.originalUrl.split('?')[0]} ${respuesta.statusCode} ` +
          `${ms.toFixed(1)}ms ip=${contexto.ip ?? '-'}${contexto.usuario ? ` user=${contexto.usuario}` : ''}` +
          (contexto.cliente ? ` client=${contexto.cliente}` : ''),
      );
      acceso.log(lineaDeAcceso(contexto, peticion.method, respuesta.statusCode, ms));
    });
  });
  next();
}

/**
 * Segundo middleware: abre el contexto asíncrono (AsyncLocalStorage) con el mismo objeto.
 * Va DESPUÉS del parser del cuerpo: los eventos de la petición que el parser escucha se
 * emiten fuera del contexto y, si el contexto se abriera antes, el parser lo perdería.
 */
export function middlewareContexto(peticion: Request, _respuesta: Response, next: NextFunction) {
  const contexto = contextoDeLaPeticion(peticion);
  if (contexto === undefined) return next();
  ejecutarEnContexto(contexto, next);
}
