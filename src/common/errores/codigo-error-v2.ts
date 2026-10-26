import { CodigoError } from './codigo-error';

/**
 * Lista cerrada de `code` del ProblemDetails del contrato v2
 * (components.schemas.ProblemDetails.code en contracts/vuelos-openapi-v2.yaml). Incluye todos los
 * de v1 menos AUTH_UNAVAILABLE (en v2 es PROVIDER_UNAVAILABLE) y suma los genéricos que v1 no
 * tiene (UNAUTHORIZED, NOT_FOUND, INTERNAL_ERROR...). Si el contrato cambia, cambia con él.
 */
export enum CodigoErrorV2 {
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  IDEMPOTENCY_KEY_REUSED = 'IDEMPOTENCY_KEY_REUSED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  PROVIDER_UNAVAILABLE = 'PROVIDER_UNAVAILABLE',
  OFFER_NO_LONGER_AVAILABLE = 'OFFER_NO_LONGER_AVAILABLE',
  HOLD_EXPIRED = 'HOLD_EXPIRED',
  HOLD_ALREADY_CONSUMED = 'HOLD_ALREADY_CONSUMED',
  SEAT_TAKEN = 'SEAT_TAKEN',
  SEAT_CABIN_MISMATCH = 'SEAT_CABIN_MISMATCH',
  INFANT_SEAT_NOT_ALLOWED = 'INFANT_SEAT_NOT_ALLOWED',
  INFANT_WITHOUT_ADULT = 'INFANT_WITHOUT_ADULT',
  PASSENGER_COUNT_MISMATCH = 'PASSENGER_COUNT_MISMATCH',
  DOCUMENT_EXPIRED = 'DOCUMENT_EXPIRED',
  PASSPORT_REQUIRED_INTERNATIONAL = 'PASSPORT_REQUIRED_INTERNATIONAL',
  PAYMENT_REFERENCE_INVALID = 'PAYMENT_REFERENCE_INVALID',
  PAYMENT_NOT_AUTHORIZED = 'PAYMENT_NOT_AUTHORIZED',
  AMOUNT_MISMATCH = 'AMOUNT_MISMATCH',
  PNR_CREATION_FAILED = 'PNR_CREATION_FAILED',
  BOOKING_NOT_CONFIRMED = 'BOOKING_NOT_CONFIRMED',
  TICKET_ISSUANCE_FAILED = 'TICKET_ISSUANCE_FAILED',
  TICKET_ALREADY_ISSUED = 'TICKET_ALREADY_ISSUED',
  BAGGAGE_LIMIT_EXCEEDED = 'BAGGAGE_LIMIT_EXCEEDED',
  FARE_NOT_CHANGEABLE = 'FARE_NOT_CHANGEABLE',
  CHANGE_OFFER_EXPIRED = 'CHANGE_OFFER_EXPIRED',
  QUOTE_EXPIRED = 'QUOTE_EXPIRED',
  ALREADY_CANCELLED = 'ALREADY_CANCELLED',
  BOOKING_NOT_CANCELLABLE = 'BOOKING_NOT_CANCELLABLE',
  CUTOFF_PASSED = 'CUTOFF_PASSED',
  CHECK_IN_NOT_AVAILABLE = 'CHECK_IN_NOT_AVAILABLE',
  CHECK_IN_FAILED = 'CHECK_IN_FAILED',
  BOARDING_PASS_NOT_AVAILABLE = 'BOARDING_PASS_NOT_AVAILABLE',
  FLIGHT_ALREADY_DEPARTED = 'FLIGHT_ALREADY_DEPARTED',
  FLIGHT_CANCELLED = 'FLIGHT_CANCELLED',
  FLIGHT_STATUS_NOT_AVAILABLE = 'FLIGHT_STATUS_NOT_AVAILABLE',
  INVALID_STATUS_TRANSITION = 'INVALID_STATUS_TRANSITION',
  PROMOTION_DISCOUNT_OUT_OF_RANGE = 'PROMOTION_DISCOUNT_OUT_OF_RANGE',
}

/**
 * Lo que un error de negocio responde en /api/v2 cuando no es lo mismo que en v1: el `code` del
 * enum v2 y, si cambia, el status (la clave de idempotencia con otro cuerpo es 422 en v1 y 409
 * en v2). Lo lleva `ErrorNegocio` en la opción `v2`; v1 lo ignora.
 */
export interface PistaV2 {
  code: CodigoErrorV2;
  status?: number;
}

const DE_V1: ReadonlySet<string> = new Set(Object.values(CodigoErrorV2));

/**
 * El `code` v2 de un error que no trae pista: el genérico de su status cuando v1 no tenía uno
 * (v1 usa VALIDATION_FAILED para 401, 403, 404 y 5xx) y, si no, el mismo de v1.
 */
export function codigoV2PorDefecto(status: number, codigo: CodigoError): CodigoErrorV2 {
  if (status === 401) return CodigoErrorV2.UNAUTHORIZED;
  if (status === 403) return CodigoErrorV2.FORBIDDEN;
  if (status === 404) return CodigoErrorV2.NOT_FOUND;
  if (status === 503 || status === 504) return CodigoErrorV2.PROVIDER_UNAVAILABLE;
  if (status >= 500) return CodigoErrorV2.INTERNAL_ERROR;
  return DE_V1.has(codigo) ? (codigo as string as CodigoErrorV2) : CodigoErrorV2.VALIDATION_FAILED;
}
