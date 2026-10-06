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

/** Un reembolso de lo que se cobró con `referenciaPago`. */
export interface ReembolsoPedido {
  /** La referencia del pago original (el de la emisión). */
  referenciaPago: string;
  /** Identifica el reembolso (el quoteId): pedirlo dos veces no reembolsa dos veces. */
  operacion: string;
  moneda: string;
  monto: Prisma.Decimal;
}

export type EstadoReembolso = 'APROBADO' | 'PENDIENTE' | 'RECHAZADO';

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
  /** Pide el reembolso (idempotente por `operacion`). */
  reembolsar(reembolso: ReembolsoPedido): Promise<EstadoReembolso>;
  /** El estado de un reembolso pedido antes (si no existiera, lo pide). */
  consultarReembolso(reembolso: ReembolsoPedido): Promise<EstadoReembolso>;
}

/** Token de inyección: `@Inject(SERVICIO_PAGOS) pagos: ServicioPagos`. */
export const SERVICIO_PAGOS = Symbol('ServicioPagos');
