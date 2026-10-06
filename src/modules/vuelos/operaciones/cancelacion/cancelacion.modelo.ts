import { Prisma } from '../../../../generated/prisma/client';

/** Una cotización de cancelación (cotizacion_cancelacion). */
export interface Cotizacion {
  id: string;
  moneda: string;
  reembolso: Prisma.Decimal;
  penalidad: Prisma.Decimal;
  vence: Date;
}
