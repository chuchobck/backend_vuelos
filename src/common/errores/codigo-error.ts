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
  /**
   * Propio del proyecto, no está en el contrato (ver docs/DISCREPANCIAS-CONTRATO.md): 503 cuando,
   * con AUTH_MODE=external, no hay claves del servicio de identidad con las que verificar el
   * token. No es un 401: el cliente no hizo nada mal y debe reintentar (Retry-After).
   */
  AUTH_UNAVAILABLE = 'AUTH_UNAVAILABLE',
  /**
   * Propios del proyecto, de las operaciones de la fase F1, que el contrato no tiene (embarque y
   * kiosko; ver docs/DISCREPANCIAS-CONTRATO.md 2.5 y docs/F1-DISENO.md). Solo salen en esas rutas.
   */
  /** 400: el texto escaneado no tiene el formato de un pase (BP1|...). */
  BOARDING_PASS_MALFORMED = 'BOARDING_PASS_MALFORMED',
  /** 422: el formato es de un pase, pero la firma no es la de esta API (código alterado). */
  BOARDING_PASS_SIGNATURE_INVALID = 'BOARDING_PASS_SIGNATURE_INVALID',
  /** 404: el boleto del pase no existe o no es de esa reserva. */
  BOARDING_PASS_NOT_FOUND = 'BOARDING_PASS_NOT_FOUND',
  /** 409: la reserva o el boleto ya no están vigentes, o el pase no es el emitido. */
  BOARDING_PASS_NOT_VALID = 'BOARDING_PASS_NOT_VALID',
  /** 409: el pase es de otra salida (otro vuelo, otra fecha u otra ruta). */
  BOARDING_PASS_WRONG_FLIGHT = 'BOARDING_PASS_WRONG_FLIGHT',
  /** 409: el pasajero no tiene check-in en esa salida. */
  PASSENGER_NOT_CHECKED_IN = 'PASSENGER_NOT_CHECKED_IN',
  /** 409: el pasajero ya abordó (también el que pierde una carrera de dos escaneos). */
  ALREADY_BOARDED = 'ALREADY_BOARDED',
  /** 409: la salida que la puerta embarca está cancelada. */
  FLIGHT_CANCELLED = 'FLIGHT_CANCELLED',
  /** 401: la sesión del kiosko falta, está alterada o venció (WWW-Authenticate: Kiosk). */
  KIOSK_SESSION_INVALID = 'KIOSK_SESSION_INVALID',
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
