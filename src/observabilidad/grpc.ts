import { Context, Span, SpanKind, trace } from '@opentelemetry/api';
import { ServerUnaryCall } from '@grpc/grpc-js';
import { Observabilidad } from './observabilidad';
import { CLAVE_REQUEST_ID, marcarError } from './trazas';

/** La metadata del traceparent: la cabecera de HTTP, en minúsculas como pide gRPC. */
export const METADATA_TRACEPARENT = 'traceparent';

/** El span SERVER de una llamada gRPC en curso y su contexto de OpenTelemetry. */
export interface ObservacionLlamada {
  span: Span;
  contexto: Context;
  inicio: bigint;
  /** `quinde.flights.v1.FlightsService/SearchFlights`: la RPC, que hace de plantilla de la ruta. */
  rpc: string;
  terminada: boolean;
}

/**
 * Abre el span SERVER de una llamada gRPC, hijo del `traceparent` de la metadata (con
 * TRACE_TRUST_INCOMING=true; si falta o no es válido, una traza raíz). `contextoDeLlamada` lo
 * llama la primera vez que se pide el contexto de la llamada: o el interceptor, o el filtro de
 * errores si el guard la rechazó antes.
 */
export function abrirSpanGrpc(
  obs: Observabilidad,
  llamada: ServerUnaryCall<unknown, unknown>,
  requestId: string,
): ObservacionLlamada {
  const rpc = llamada.getPath().replace(/^\//, '');
  const valores = llamada.metadata.get(METADATA_TRACEPARENT);
  const padre = obs.trazas.contextoEntrante(
    valores.length === 1 && typeof valores[0] === 'string' ? valores[0] : undefined,
  );
  const [servicio, metodo] = rpc.split('/');
  const span = obs.trazas.iniciar(
    rpc,
    SpanKind.SERVER,
    {
      'rpc.system': 'grpc',
      'rpc.service': servicio,
      'rpc.method': metodo,
      'quinde.request_id': requestId,
    },
    padre,
  );
  return {
    span,
    contexto: trace.setSpan(padre, span).setValue(CLAVE_REQUEST_ID, requestId),
    inicio: process.hrtime.bigint(),
    rpc,
    terminada: false,
  };
}

/** Un status gRPC de falta del servidor (el cliente no tuvo la culpa): marca el span como error. */
const ERROR_DEL_SERVIDOR: Record<number, string> = {
  2: '500', // UNKNOWN
  4: '504', // DEADLINE_EXCEEDED
  12: '500', // UNIMPLEMENTED
  13: '500', // INTERNAL
  14: '503', // UNAVAILABLE
  15: '500', // DATA_LOSS
};

/**
 * Cierra el span SERVER de la llamada con `rpc.grpc.status_code` y registra las métricas del
 * servidor: método POST (gRPC va sobre HTTP/2), la RPC como ruta y el status HTTP que habría dado
 * el mismo resultado en REST. Se puede llamar dos veces (el interceptor y el filtro): la segunda
 * no hace nada.
 */
export function cerrarSpanGrpc(
  obs: Observabilidad,
  observacion: ObservacionLlamada,
  codigoGrpc: number,
  statusHttp: number,
): void {
  if (observacion.terminada) return;
  observacion.terminada = true;
  const { span } = observacion;
  span.setAttribute('rpc.grpc.status_code', codigoGrpc);
  const tipo = ERROR_DEL_SERVIDOR[codigoGrpc];
  if (tipo !== undefined) marcarError(span, tipo);
  span.end();
  obs.metricas.registrarServidor(
    'POST',
    observacion.rpc,
    statusHttp,
    Number(process.hrtime.bigint() - observacion.inicio) / 1e9,
  );
}
