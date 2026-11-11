import { estado_vuelo } from '../../../../generated/prisma/client';

/** El aeropuerto de la pantalla, con la zona horaria de su ciudad. */
export interface AeropuertoDeSalidas {
  iata: string;
  nombre: string;
  ciudad: string;
  zonaHoraria: string;
}

/** Una salida en la pantalla. Solo datos del vuelo: nada de reservas, cupos ni pasajeros. */
export interface SalidaEnPantalla {
  /** vuelo_programado.id: solo para el cursor, no sale en la respuesta. */
  id: string;
  numeroVuelo: string;
  aerolinea: string;
  destino: string;
  ciudadDestino: string;
  programada: Date;
  estimada: Date | null;
  estado: estado_vuelo;
  terminal: string | null;
  puerta: string | null;
}

/** Una página de la pantalla de salidas de un aeropuerto en una fecha local. */
export interface TableroDeSalidas {
  aeropuerto: AeropuertoDeSalidas;
  /** La fecha local pedida (un `date`). */
  fecha: Date;
  salidas: SalidaEnPantalla[];
  nextCursor?: string;
}
