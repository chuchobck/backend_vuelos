import {
  clase_cabina,
  estado_vuelo,
  Prisma,
  tipo_pasajero,
} from '../../../../generated/prisma/client';

/**
 * Lo que arma la búsqueda antes de traducirlo al contrato. Montos en Decimal: nunca pasan
 * por un number de JavaScript.
 */

/** Una salida programada que se puede vender hoy. */
export interface SalidaVendible {
  /** vuelo_programado.id: el segmentId del contrato. */
  id: string;
  numeroVuelo: string;
  /** aerolinea.id de la que comercializa: interno, para guardar la oferta; nunca sale. */
  aerolineaId: bigint;
  comercializa: string;
  nombreComercializa: string;
  opera: string;
  origen: string;
  destino: string;
  fechaSalida: Date;
  salida: Date;
  llegada: Date;
  terminalSalida: string | null;
  terminalLlegada: string | null;
  estado: estado_vuelo;
  modelo: string;
}

/** Precio de UN pasajero de un tipo, sumado sobre los segmentos del itinerario. */
export interface PrecioPasajero {
  tipo: tipo_pasajero;
  base: Prisma.Decimal;
  impuestos: Prisma.Decimal;
}

/** Una familia tarifaria vendible en todos los segmentos de un itinerario (CabinPricing). */
export interface OpcionTarifa {
  familiaId: string;
  codigo: string;
  cabina: clase_cabina;
  esCambiable: boolean;
  reembolsable: boolean;
  articuloPersonal: boolean;
  equipajeMano: number;
  equipajeBodega: number;
  moneda: string;
  /** El menor cupo disponible de esa cabina entre los segmentos. */
  asientosDisponibles: number;
  /** Precio por maleta adicional, sumado sobre los segmentos. */
  equipajeAdicional: Prisma.Decimal;
  precios: PrecioPasajero[];
  /** Base, impuestos y total de todos los pasajeros pedidos con esta familia. */
  totalPasajeros: Totales;
}

export interface Totales {
  base: Prisma.Decimal;
  impuestos: Prisma.Decimal;
  total: Prisma.Decimal;
}

/** Un itinerario (directo o con escala) para un tramo pedido, con sus familias vendibles. */
export interface ItinerarioArmado {
  /** itinerario_cabecera.id; se genera al armarlo y se guarda con la oferta. */
  id: string;
  segmentos: SalidaVendible[];
  /** De la más barata a la más cara (para los pasajeros pedidos). */
  opciones: OpcionTarifa[];
}

/** Una oferta: un itinerario por tramo pedido, todos de la misma aerolínea. */
export interface OfertaArmada {
  /** oferta_cabecera.id. */
  id: string;
  aerolinea: { codigo: string; nombre: string };
  itinerarios: ItinerarioArmado[];
  moneda: string;
  /** Todos los pasajeros con la familia más barata de cada itinerario. */
  total: Totales;
}
