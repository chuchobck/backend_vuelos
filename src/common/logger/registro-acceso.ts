import { ContextoPeticion } from '../contexto/contexto-peticion';

/** Contexto de Logger de la línea de acceso en JSON: LoggerPorPeticion la imprime tal cual. */
export const CONTEXTO_ACCESO = 'Acceso';

/** `service` de la línea de acceso: este servicio en el ecosistema. */
export const NOMBRE_SERVICIO = 'core-vuelos';

/**
 * La línea de acceso estructurada que pide el contrato v2 (§6, regla 4): una por petición, con
 * lo necesario para reconstruir un proceso por su correlation_id. Nada de la URL pedida (lleva
 * ids), de la query, del cuerpo, de la IP ni del usuario: `operation` dice qué se atendió.
 *
 *   {"timestamp":"2026-10-26T15:00:00.000Z","level":"info","service":"core-vuelos",
 *    "correlation_id":"corr-123","request_id":"8d1f...","operation":"createBooking",
 *    "method":"POST","status":201,"latency_ms":48.3,"trace_id":"4bf9...","span_id":"00f0..."}
 *
 * `client_id` solo con un token de partner (o de otro cliente máquina a máquina); `trace_id` y
 * `span_id`, los del span SERVER de la petición (observabilidad), si lo hubo.
 */
export function lineaDeAcceso(
  contexto: ContextoPeticion,
  metodo: string,
  status: number,
  ms: number,
  ahora: Date = new Date(),
): string {
  return JSON.stringify({
    timestamp: ahora.toISOString(),
    level: status >= 500 ? 'error' : 'info',
    service: NOMBRE_SERVICIO,
    correlation_id: contexto.correlationId,
    request_id: contexto.requestId,
    operation: contexto.operacion ?? null,
    method: metodo,
    status,
    latency_ms: Math.round(ms * 10) / 10,
    ...(contexto.cliente ? { client_id: contexto.cliente } : {}),
    ...(contexto.traza ? { trace_id: contexto.traza.traceId, span_id: contexto.traza.spanId } : {}),
  });
}
