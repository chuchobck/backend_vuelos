/**
 * Lista cerrada de `code` del esquema ProblemDetails del contrato
 * (components.schemas.ProblemDetails.code en contracts/vuelos-openapi.yaml).
 * Si el contrato cambia, esta lista cambia con él: no se agregan códigos propios.
 */
export enum CodigoError {
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  SEAT_TAKEN = 'SEAT_TAKEN',
  AMOUNT_MISMATCH = 'AMOUNT_MISMATCH',
  BOOKING_NOT_CONFIRMED = 'BOOKING_NOT_CONFIRMED',
  BAGGAGE_LIMIT_EXCEEDED = 'BAGGAGE_LIMIT_EXCEEDED',
  CUTOFF_PASSED = 'CUTOFF_PASSED',
  FARE_NOT_CHANGEABLE = 'FARE_NOT_CHANGEABLE',
  FLIGHT_ALREADY_DEPARTED = 'FLIGHT_ALREADY_DEPARTED',
  CHANGE_OFFER_EXPIRED = 'CHANGE_OFFER_EXPIRED',
  OFFER_NO_LONGER_AVAILABLE = 'OFFER_NO_LONGER_AVAILABLE',
  QUOTE_EXPIRED = 'QUOTE_EXPIRED',
  ALREADY_CANCELLED = 'ALREADY_CANCELLED',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  INFANT_SEAT_NOT_ALLOWED = 'INFANT_SEAT_NOT_ALLOWED',
  PAYMENT_REFERENCE_INVALID = 'PAYMENT_REFERENCE_INVALID',
  PAYMENT_NOT_AUTHORIZED = 'PAYMENT_NOT_AUTHORIZED',
  PNR_CREATION_FAILED = 'PNR_CREATION_FAILED',
  TICKET_ISSUANCE_FAILED = 'TICKET_ISSUANCE_FAILED',
  TICKET_ALREADY_ISSUED = 'TICKET_ALREADY_ISSUED',
  CHECK_IN_NOT_AVAILABLE = 'CHECK_IN_NOT_AVAILABLE',
  CHECK_IN_FAILED = 'CHECK_IN_FAILED',
  BOARDING_PASS_NOT_AVAILABLE = 'BOARDING_PASS_NOT_AVAILABLE',
  SEAT_CABIN_MISMATCH = 'SEAT_CABIN_MISMATCH',
  FLIGHT_STATUS_NOT_AVAILABLE = 'FLIGHT_STATUS_NOT_AVAILABLE',
}

/**
 * `code` es obligatorio en ProblemDetails y la lista no trae códigos para 401, 403, 404, 405,
 * 413, 415 ni 5xx. Esos casos usan el que sí existe para "la petición no es válida" y el
 * `status` HTTP dice qué pasó. Es el único lugar donde se decide: cambiarlo aquí cambia todo.
 */
export const CODIGO_SIN_EQUIVALENTE = CodigoError.VALIDATION_FAILED;

/** Código del contrato que corresponde a un status cuando el error no trae uno propio. */
export function codigoPorStatus(status: number): CodigoError {
  return status === 429 ? CodigoError.RATE_LIMIT_EXCEEDED : CODIGO_SIN_EQUIVALENTE;
}
