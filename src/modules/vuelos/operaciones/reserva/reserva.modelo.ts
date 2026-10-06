import {
  clase_cabina,
  estado_reserva,
  genero,
  Prisma,
  tipo_documento,
  tipo_pasajero,
} from '../../../../generated/prisma/client';
import { Boleto } from '../boleto/boleto.modelo';
import { SalidaVendible } from '../busqueda/busqueda.modelo';

/** grandTotal: vista_reserva_total (itinerarios vigentes, equipaje y cargos de cambio). */
export interface MontoReserva {
  moneda: string;
  base: Prisma.Decimal;
  impuestos: Prisma.Decimal;
  total: Prisma.Decimal;
}

/** La familia tarifaria vendida en un itinerario, con sus reglas de hoy. */
export interface FamiliaVendida {
  codigo: string;
  cabina: clase_cabina;
  esCambiable: boolean;
  reembolsable: boolean;
  articuloPersonal: boolean;
  equipajeMano: number;
  equipajeBodega: number;
  /** Precio actual de una maleta adicional, sumado sobre los segmentos. */
  equipajeAdicional: Prisma.Decimal;
  /** Maletas adicionales que admite la familia por pasajero en el itinerario. */
  maximoEquipaje: number;
  /** El menor cupo disponible de esa cabina entre los segmentos, hoy. */
  asientosDisponibles: number;
}

/** Un itinerario vigente de la reserva (reserva_detalle_itinerario) con sus segmentos. */
export interface ItinerarioDeReserva {
  id: string;
  orden: number;
  familia: FamiliaVendida;
  /** Base e impuestos congelados en el hold, para todos los pasajeros. */
  base: Prisma.Decimal;
  impuestos: Prisma.Decimal;
  salidas: SalidaVendible[];
}

export interface PasajeroDeReserva {
  /** passengerId del contrato (codigo_pasajero). */
  codigo: string;
  tipo: tipo_pasajero;
  /** passengerId del adulto responsable (solo infantes). */
  adultoResponsable: string | null;
  nombres: string;
  apellidos: string;
  tipoDocumento: tipo_documento;
  numeroDocumento: string;
  /** País ISO 3166-1 alfa-2. */
  nacionalidad: string;
  vencimientoDocumento: Date | null;
  nacimiento: Date;
  genero: genero;
  correo: string;
  telefono: string;
  /** Asientos vigentes (sin fecha_liberacion), con el número del contrato (12A). */
  asientos: Array<{ salidaId: string; numero: string }>;
  equipaje: Array<{ itinerarioId: string; cantidad: number }>;
}

/** Una reserva completa, como la devuelve GET /bookings/{bookingId}. */
export interface Reserva {
  id: string;
  pnr: string;
  estado: estado_reserva;
  creada: Date;
  actualizada: Date;
  total: MontoReserva;
  itinerarios: ItinerarioDeReserva[];
  pasajeros: PasajeroDeReserva[];
  boletos: Boleto[];
  historial: Array<{ fecha: Date; descripcion: string }>;
}

/** Una fila de GET /bookings. */
export interface ResumenReserva {
  id: string;
  pnr: string;
  estado: estado_reserva;
  origen: string;
  destino: string;
  /** Fecha local de la primera salida (un `date`). */
  fechaSalida: Date;
  total: MontoReserva;
}
