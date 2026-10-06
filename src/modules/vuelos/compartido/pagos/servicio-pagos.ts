import { concepto_pago, Prisma } from '../../../../generated/prisma/client';

/**
 * Lo que dice la Payment API de un pago:
 * - APROBADO: autorizado; la operación sigue (la reserva emite sus boletos).
 * - PENDIENTE: todavía no se sabe; la operación espera y se vuelve a consultar después.
 * - RECHAZADO: no autorizado; la operación no se hace.
 * - INVALIDO: la referencia no es de ningún pago.
 */
export type EstadoPago = 'APROBADO' | 'PENDIENTE' | 'RECHAZADO' | 'INVALIDO';

/** El cobro que la operación espera que cubra el pago. Nunca datos de tarjeta. */
export interface CobroEsperado {
  referencia: string;
  concepto: concepto_pago;
  moneda: string;
  monto: Prisma.Decimal;
}

/**
 * La Payment API vista desde vuelos. Esta API no procesa pagos (lo dice el contrato): recibe
 * una `paymentReference` de un pago que el cliente ya hizo allá y pregunta su estado. Hoy la
 * implementa `PagosSimulados`; en RDA2 se reemplaza por un cliente HTTP de la Payment API real
 * sin tocar las reservas (ver `PagosModule`).
 */
export interface ServicioPagos {
  /** Al crear la operación: el estado del pago con esa referencia, para ese cobro. */
  autorizar(cobro: CobroEsperado): Promise<EstadoPago>;
  /** Más tarde, para un pago que quedó PENDIENTE. */
  consultar(referencia: string): Promise<Exclude<EstadoPago, 'INVALIDO'>>;
}

/** Token de inyección: `@Inject(SERVICIO_PAGOS) pagos: ServicioPagos`. */
export const SERVICIO_PAGOS = Symbol('ServicioPagos');
