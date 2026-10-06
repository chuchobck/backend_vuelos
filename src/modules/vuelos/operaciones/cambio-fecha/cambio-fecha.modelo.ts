import { Prisma } from '../../../../generated/prisma/client';
import { SalidaVendible } from '../busqueda/busqueda.modelo';

/** Diferencia de precio de un cambio, para todos los pasajeros y todos los itinerarios. */
export interface DiferenciaPrecio {
  tarifa: Prisma.Decimal;
  impuestos: Prisma.Decimal;
  cargo: Prisma.Decimal;
  /** max(0, tarifa + impuestos) + cargo: lo que baja no se devuelve; el cargo se cobra siempre. */
  aPagar: Prisma.Decimal;
}

/** Una oferta de cambio guardada (cambio_cabecera OFERTADO) con los vuelos nuevos. */
export interface OpcionCambio {
  id: string;
  vence: Date;
  salidas: SalidaVendible[];
  diferencia: DiferenciaPrecio;
}
