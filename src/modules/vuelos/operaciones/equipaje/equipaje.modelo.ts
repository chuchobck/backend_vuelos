import { Prisma } from '../../../../generated/prisma/client';

/** Lo que puede comprar un pasajero en un itinerario (BaggageOptionsResponse). */
export interface OpcionEquipaje {
  codigoPasajero: string;
  itinerarioId: string;
  moneda: string;
  /** Precio de una maleta: el de hoy, sumado sobre los vuelos del itinerario. */
  precio: Prisma.Decimal;
  maximo: number;
  comprado: number;
}

/** El resultado de una compra (BaggageAddedResponse). */
export interface EquipajeAgregado {
  codigoPasajero: string;
  itinerarioId: string;
  total: number;
}
