import { Prisma } from '../../../generated/prisma/client';

/**
 * Formatos de salida comunes de los mappers.
 *
 * - Dinero y porcentajes: texto con 2 decimales, como MoneyAmount del contrato. Nunca pasan
 *   por un number de JavaScript, que no representa 0.1 exacto.
 * - Instantes (timestamptz): ISO 8601 en UTC.
 * - Fechas (date): `YYYY-MM-DD`. Prisma las entrega a medianoche UTC; se leen en UTC para
 *   que la zona horaria del servidor no corra el día.
 */
export function aTextoDecimal(valor: Prisma.Decimal): string {
  return valor.toFixed(2);
}

export function aInstante(valor: Date): string;
export function aInstante(valor: Date | null): string | null;
export function aInstante(valor: Date | null): string | null {
  return valor === null ? null : valor.toISOString();
}

export function aFecha(valor: Date): string {
  return valor.toISOString().slice(0, 10);
}
