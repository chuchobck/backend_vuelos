import { Logger } from '@nestjs/common';
import { ServerUnaryCall } from '@grpc/grpc-js';
import { ContextoPeticion, ejecutarEnContexto, normalizarIp } from './contexto-peticion';
import { resolverRequestId } from './request-id';

/** La metadata del request id: la cabecera X-Request-Id de HTTP, en minúsculas como pide gRPC. */
export const METADATA_REQUEST_ID = 'x-request-id';

export type LlamadaGrpc = ServerUnaryCall<unknown, unknown>;

/** Una llamada gRPC en curso: su contexto (el mismo tipo que el de HTTP) y lo que pide su log. */
export interface ContextoLlamada {
  contexto: ContextoPeticion;
  /** `/quinde.flights.v1.FlightsService/SearchFlights`. */
  metodo: string;
  inicio: bigint;
}

const CONTEXTO_EN_LLAMADA = Symbol('contextoLlamada');

type LlamadaConContexto = LlamadaGrpc & { [CONTEXTO_EN_LLAMADA]?: ContextoLlamada };

const logger = new Logger('gRPC');

/**
 * El contexto de una llamada gRPC, creado la primera vez que se pide y guardado en la llamada:
 * el interceptor lo abre en el AsyncLocalStorage de HTTP y el filtro de errores lo reusa
 * aunque el error ocurra antes del interceptor (en un guard).
 *
 * - requestId: la metadata x-request-id con las reglas de la cabecera X-Request-Id (si falta,
 *   se repite o no es válida, uno nuevo).
 * - ip: la del cliente que abrió la conexión (el BFF), sin el puerto.
 * - usuario: null; las RPC de hoy son públicas.
 */
export function contextoDeLlamada(llamada: LlamadaGrpc): ContextoLlamada {
  const conContexto = llamada as LlamadaConContexto;
  if (conContexto[CONTEXTO_EN_LLAMADA] === undefined) {
    const valores = llamada.metadata.get(METADATA_REQUEST_ID);
    conContexto[CONTEXTO_EN_LLAMADA] = {
      contexto: {
        requestId: resolverRequestId(valores.length === 1 ? String(valores[0]) : undefined),
        ip: ipDelPar(llamada.getPeer()),
        usuario: null,
      },
      metodo: llamada.getPath(),
      inicio: process.hrtime.bigint(),
    };
  }
  return conContexto[CONTEXTO_EN_LLAMADA];
}

/**
 * La línea de acceso de una llamada, como la de HTTP:
 *
 *   LOG [gRPC] [8d1f...] /quinde.flights.v1.FlightsService/GetFlightStatus OK 3.1ms ip=10.0.0.7
 *
 * `estado` es el nombre del código gRPC (OK, NOT_FOUND...). Sin el mensaje ni la metadata.
 */
export function registrarLlamada({ contexto, metodo, inicio }: ContextoLlamada, estado: string) {
  const ms = Number(process.hrtime.bigint() - inicio) / 1e6;
  ejecutarEnContexto(contexto, () =>
    logger.log(`${metodo} ${estado} ${ms.toFixed(1)}ms ip=${contexto.ip ?? '-'}`),
  );
}

/** `127.0.0.1:54321`, `::ffff:10.0.0.7:54321` o `::1:54321` (getPeer de grpc-js) → la IP. */
function ipDelPar(par: string): string | null {
  const sinPuerto = /^(.+):\d+$/.exec(par)?.[1];
  return sinPuerto === undefined ? null : normalizarIp(sinPuerto);
}
