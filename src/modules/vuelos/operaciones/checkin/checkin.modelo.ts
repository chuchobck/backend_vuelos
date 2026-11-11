/**
 * Estado de un pasajero en un segmento (o de un pasajero en todos): CHECKED_IN, NOT_CHECKED_IN
 * (todavía no abre la ventana o no se intentó) o FAILED (ya no se puede: cerró la ventana, el
 * vuelo salió o se canceló).
 */
export type EstadoCheckinPasajero = 'CHECKED_IN' | 'NOT_CHECKED_IN' | 'FAILED';

/** CheckInStatus del contrato: el estado general del check-in de la reserva. */
export type EstadoGeneralCheckin =
  'NOT_ELIGIBLE' | 'AVAILABLE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';

/** Un pasajero en un vuelo de la reserva. */
export interface TramoCheckin {
  /** vuelo_programado.id: el segmentId del contrato. */
  salidaId: string;
  estado: EstadoCheckinPasajero;
  /** Asiento (12A) del pasajero en ese vuelo; null para un infante. */
  asiento: string | null;
}

export interface PasajeroCheckin {
  /** passengerId del contrato (codigo_pasajero). */
  codigo: string;
  estado: EstadoCheckinPasajero;
  tramos: TramoCheckin[];
}

/** Lo que devuelve POST /bookings/{bookingId}/check-in. */
export interface ResultadoCheckin {
  reservaId: string;
  estado: EstadoGeneralCheckin;
  pasajeros: PasajeroCheckin[];
}

/** La ventana de check-in de un vuelo en un instante. */
export type Ventana = 'abierta' | 'aun-no' | 'cerrada';

/** La ventana de check-in de un vuelo de la reserva: cuándo abre, cuándo cierra y cómo está. */
export interface VentanaDeVuelo {
  salidaId: string;
  estado: Ventana;
  abre: Date;
  cierra: Date;
}

/** El check-in de una reserva en este momento, sin registrar nada (lo muestra el kiosko). */
export interface EstadoDeCheckin {
  resultado: ResultadoCheckin;
  ventanas: VentanaDeVuelo[];
}
