import {
  clase_cabina,
  estado_boleto,
  estado_cupon,
  estado_reserva,
  estado_retencion,
  estado_vuelo,
  genero,
  posicion_asiento,
  tipo_documento,
  tipo_pasajero,
} from '../../../generated/prisma/client';

/**
 * Traducción de los ENUM de la base (en español) a los valores del contrato (en inglés), en
 * los dos sentidos. Las equivalencias son las del COMMENT ON TYPE de db/esquema_vuelos.sql.
 */
export interface Traduccion<Base extends string, Contrato extends string> {
  /** Los valores del contrato, para @IsIn y para Swagger. */
  readonly valores: readonly Contrato[];
  aContrato(valor: Base): Contrato;
  aBase(valor: Contrato): Base;
}

function traduccion<Base extends string, Contrato extends string>(
  mapa: Record<Base, Contrato>,
): Traduccion<Base, Contrato> {
  const inverso = new Map<Contrato, Base>();
  for (const [base, contrato] of Object.entries(mapa) as Array<[Base, Contrato]>) {
    inverso.set(contrato, base);
  }
  return {
    valores: [...inverso.keys()],
    aContrato: (valor) => mapa[valor],
    aBase: (valor) => {
      const base = inverso.get(valor);
      if (base === undefined) throw new Error(`Valor sin traducción: ${valor}`);
      return base;
    },
  };
}

/** Contrato cabinClass. */
export const CABINA = traduccion<
  clase_cabina,
  'ECONOMY' | 'PREMIUM_ECONOMY' | 'BUSINESS' | 'FIRST'
>({
  ECONOMICA: 'ECONOMY',
  ECONOMICA_PREMIUM: 'PREMIUM_ECONOMY',
  EJECUTIVA: 'BUSINESS',
  PRIMERA: 'FIRST',
});
export type CabinaContrato = (typeof CABINA.valores)[number];

/**
 * El orden del ENUM clase_cabina en la base (el de ORDER BY clase_cabina). Quien bloquea
 * varias filas de inventario_cabina lo hace en este orden, para no cruzarse con otro.
 */
export const ORDEN_CABINAS: readonly clase_cabina[] = [
  'ECONOMICA',
  'ECONOMICA_PREMIUM',
  'EJECUTIVA',
  'PRIMERA',
];

/**
 * Posición del asiento. El contrato solo nombra WINDOW y AISLE (como características); el
 * asiento del centro es MIDDLE en la API de administración.
 */
export const POSICION_ASIENTO = traduccion<posicion_asiento, 'WINDOW' | 'MIDDLE' | 'AISLE'>({
  VENTANA: 'WINDOW',
  CENTRO: 'MIDDLE',
  PASILLO: 'AISLE',
});
export type PosicionContrato = (typeof POSICION_ASIENTO.valores)[number];

/** Contrato FlightStatus.status. */
export const ESTADO_VUELO = traduccion<
  estado_vuelo,
  'SCHEDULED' | 'BOARDING' | 'DEPARTED' | 'DELAYED' | 'ARRIVED' | 'CANCELLED' | 'DIVERTED'
>({
  PROGRAMADO: 'SCHEDULED',
  EMBARCANDO: 'BOARDING',
  DESPEGADO: 'DEPARTED',
  DEMORADO: 'DELAYED',
  ATERRIZADO: 'ARRIVED',
  CANCELADO: 'CANCELLED',
  DESVIADO: 'DIVERTED',
});
export type EstadoVueloContrato = (typeof ESTADO_VUELO.valores)[number];

/** Contrato passengerType. */
export const TIPO_PASAJERO = traduccion<tipo_pasajero, 'ADULT' | 'YOUTH' | 'CHILD' | 'INFANT'>({
  ADULTO: 'ADULT',
  JOVEN: 'YOUTH',
  NINO: 'CHILD',
  INFANTE: 'INFANT',
});
export type TipoPasajeroContrato = (typeof TIPO_PASAJERO.valores)[number];

/** Contrato HoldStatusResponse.status. */
export const ESTADO_RETENCION = traduccion<
  estado_retencion,
  'HELD' | 'RELEASED' | 'EXPIRED' | 'CONSUMED'
>({
  RETENIDA: 'HELD',
  LIBERADA: 'RELEASED',
  EXPIRADA: 'EXPIRED',
  CONSUMIDA: 'CONSUMED',
});
export type EstadoRetencionContrato = (typeof ESTADO_RETENCION.valores)[number];

/** Contrato BookingDetail.status. */
export const ESTADO_RESERVA = traduccion<
  estado_reserva,
  | 'PENDING'
  | 'PENDING_PAYMENT'
  | 'TICKET_ISSUING'
  | 'CONFIRMED'
  | 'FAILED'
  | 'CHANGE_PENDING'
  | 'CANCELLATION_PENDING'
  | 'CANCELLED'
>({
  PENDIENTE: 'PENDING',
  PENDIENTE_PAGO: 'PENDING_PAYMENT',
  EMITIENDO_BOLETOS: 'TICKET_ISSUING',
  CONFIRMADA: 'CONFIRMED',
  FALLIDA: 'FAILED',
  CAMBIO_PENDIENTE: 'CHANGE_PENDING',
  CANCELACION_PENDIENTE: 'CANCELLATION_PENDING',
  CANCELADA: 'CANCELLED',
});
export type EstadoReservaContrato = (typeof ESTADO_RESERVA.valores)[number];

/** Contrato TicketStatus. */
export const ESTADO_BOLETO = traduccion<
  estado_boleto,
  'PENDING' | 'ISSUING' | 'ISSUED' | 'FAILED' | 'VOIDED' | 'REFUNDED'
>({
  PENDIENTE: 'PENDING',
  EMITIENDO: 'ISSUING',
  EMITIDO: 'ISSUED',
  FALLIDO: 'FAILED',
  ANULADO: 'VOIDED',
  REEMBOLSADO: 'REFUNDED',
});
export type EstadoBoletoContrato = (typeof ESTADO_BOLETO.valores)[number];

/** Contrato TicketSegmentStatus. */
export const ESTADO_CUPON = traduccion<estado_cupon, 'PENDING' | 'ISSUED' | 'FAILED'>({
  PENDIENTE: 'PENDING',
  EMITIDO: 'ISSUED',
  FALLIDO: 'FAILED',
});
export type EstadoCuponContrato = (typeof ESTADO_CUPON.valores)[number];

/** Contrato PassengerItem.documentType. */
export const TIPO_DOCUMENTO = traduccion<tipo_documento, 'PASSPORT' | 'NATIONAL_ID'>({
  PASAPORTE: 'PASSPORT',
  CEDULA: 'NATIONAL_ID',
});
export type TipoDocumentoContrato = (typeof TIPO_DOCUMENTO.valores)[number];

/** Contrato PassengerItem.gender: los mismos valores en la base. */
export const GENERO = traduccion<genero, 'M' | 'F' | 'X'>({ M: 'M', F: 'F', X: 'X' });
export type GeneroContrato = (typeof GENERO.valores)[number];
