import { clase_cabina, estado_vuelo } from '../../../../generated/prisma/client';

/** La salida que una puerta embarca: lo que el pase tiene que decir de ella. */
export interface SalidaDeEmbarque {
  /** vuelo_programado.id: el segmentId del contrato. */
  id: string;
  numeroVuelo: string;
  /** Fecha local de salida en el origen (un `date`). */
  fechaSalida: Date;
  origen: string;
  destino: string;
  estado: estado_vuelo;
  puerta: string | null;
}

/** Un pasajero con nombre: solo sale en el 200 del escaneo (docs/F1-DISENO.md, sección 3). */
export interface PasajeroAbordado {
  codigo: string;
  nombres: string;
  apellidos: string;
}

/** El resultado de un escaneo aceptado. */
export interface Abordaje {
  salida: SalidaDeEmbarque;
  asiento: string;
  grupo: string | null;
  posicion: string | null;
  abordado: Date;
  pasajero: PasajeroAbordado;
  /** Los infantes que viajan en brazos de ese pasajero y abordaron con su pase. */
  infantes: PasajeroAbordado[];
}

/** En qué punto está un asiento vendido de la salida. */
export type EstadoAsientoManifiesto = 'BOOKED' | 'TICKETED' | 'CHECKED_IN' | 'BOARDED';

/** Un asiento vendido de la salida. Sin nombre, documento ni correo. */
export interface AsientoManifiesto {
  asiento: string;
  cabina: clase_cabina;
  pnr: string;
  codigoPasajero: string;
  estado: EstadoAsientoManifiesto;
  grupo: string | null;
  abordado: Date | null;
}

export interface Conteo {
  vendidos: number;
  registrados: number;
  abordados: number;
}

/** El manifiesto de una salida para la pantalla de la puerta. */
export interface Manifiesto {
  salida: SalidaDeEmbarque;
  asientos: AsientoManifiesto[];
  /** Los infantes no tienen asiento: solo se cuentan. */
  infantes: Conteo;
}
