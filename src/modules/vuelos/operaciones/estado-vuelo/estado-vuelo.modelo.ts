import { estado_vuelo } from '../../../../generated/prisma/client';

/** Una punta del vuelo (salida o llegada): lo que guarda vuelo_programado, sin inventar nada. */
export interface ExtremoEstado {
  /** Código IATA del aeropuerto. */
  iata: string;
  terminal: string | null;
  programada: Date;
  estimada: Date | null;
  real: Date | null;
}

/** El estado operativo de un vuelo en una fecha (FlightStatus). */
export interface EstadoVuelo {
  numeroVuelo: string;
  /** Fecha local de salida en el aeropuerto de origen (vuelo_programado.fecha_salida). */
  fecha: Date;
  comercializa: string;
  opera: string;
  /** Código IATA del modelo de aeronave. */
  aeronave: string;
  estado: estado_vuelo;
  salida: ExtremoEstado;
  llegada: ExtremoEstado;
}
