import { randomUUID } from 'node:crypto';
import { obtenerContexto } from './contexto-peticion';

/** La cabecera del proceso de negocio completo (contrato v2, §6). También la usa v1. */
export const CABECERA_CORRELACION = 'X-Correlation-Id';

/** La misma en la metadata gRPC, en minúsculas como pide gRPC. */
export const METADATA_CORRELACION = 'x-correlation-id';

/**
 * Formato aceptado para un X-Correlation-Id que llega: de 1 a 100 caracteres (el maxLength del
 * contrato), letras, dígitos, punto, guion, guion bajo y dos puntos. Lo demás podría falsear una
 * línea de log (saltos de línea, espacios) o una cabecera de salida.
 */
const FORMATO_VALIDO = /^[A-Za-z0-9._:-]{1,100}$/;

export function esCorrelationIdValido(valor: unknown): valor is string {
  return typeof valor === 'string' && FORMATO_VALIDO.test(valor);
}

/**
 * El id del proceso: el que llegó, SIN CAMBIOS, si tiene un formato válido; si falta, no es
 * válido o llega repetido, uno nuevo (`corr-<uuid>`). Nunca se rechaza la petición por esto.
 */
export function resolverCorrelationId(valor: string | string[] | undefined): string {
  return esCorrelationIdValido(valor) ? valor : `corr-${randomUUID()}`;
}

/** El de la petición en curso, o `undefined` fuera de una (arranque, procesos periódicos). */
export function correlacionActual(): string | undefined {
  return obtenerContexto()?.correlationId;
}
