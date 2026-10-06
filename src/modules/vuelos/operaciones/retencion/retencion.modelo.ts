import { estado_retencion, Prisma } from '../../../../generated/prisma/client';

/** lockedPrice: la suma de las líneas congeladas (vista_retencion_precio). */
export interface PrecioCongelado {
  moneda: string;
  base: Prisma.Decimal;
  impuestos: Prisma.Decimal;
  total: Prisma.Decimal;
}

/** Una retención leída de la base, ya con el estado que le corresponde al reloj actual. */
export interface Retencion {
  id: string;
  idPropietario: string;
  estado: estado_retencion;
  creada: Date;
  vence: Date;
  precio: PrecioCongelado;
}

/** Lo que devuelve POST /offers/hold al crear (y, tal cual, al repetir la misma clave). */
export interface RetencionCreada {
  id: string;
  vence: Date;
  vigenciaMinutos: number;
  precio: PrecioCongelado;
}
