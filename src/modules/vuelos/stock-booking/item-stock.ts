import { clase_cabina } from '../../../generated/prisma/client';
import { CABINA } from '../compartido/enums';

/** Un registro del contrato de Booking (POST /api/v2/inventory/stock). */
export interface RegistroStock {
  service_id: string;
  item_id: string;
  date: string;
  time_slot: string;
  available_units: number;
}

/** Lo que se lee de la base para armar un registro. */
export interface DatosStock {
  /** Aerolínea comercializadora y número: AV1632. */
  numeroVuelo: string;
  cabina: clase_cabina;
  /** `vuelo_programado.fecha_salida`: la fecha local en el aeropuerto de origen (medianoche UTC). */
  fechaSalida: Date;
  salidaProgramada: Date;
  /** Zona horaria IANA de la ciudad del aeropuerto de origen. */
  zonaHoraria: string;
  /** El cupo disponible ahora; 0 si la salida está cancelada. */
  unidades: number;
}

/** item_id = <número de vuelo>-<CABINA EN MAYÚSCULAS> con el nombre de cabina del contrato: AV1632-ECONOMY. */
export function itemId(numeroVuelo: string, cabina: clase_cabina): string {
  return `${numeroVuelo}-${CABINA.aContrato(cabina)}`;
}

/**
 * time_slot: PREGUNTA ABIERTA con Booking (docs/STOCK-BOOKING.md). Se supone la hora LOCAL de salida
 * en HH:mm, en la zona del aeropuerto de origen (Galápagos va una hora detrás del continente).
 * Es el ÚNICO lugar donde se decide: si Booking dice otra cosa (la hora de llegada, un bloque, UTC),
 * se cambia aquí y nada más.
 */
export function timeSlot(salidaProgramada: Date, zonaHoraria: string): string {
  const partes = new Intl.DateTimeFormat('en-GB', {
    timeZone: zonaHoraria,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(salidaProgramada);
  const de = (tipo: string) => partes.find((p) => p.type === tipo)?.value ?? '00';
  return `${de('hour')}:${de('minute')}`;
}

/** date: la fecha de salida como YYYY-MM-DD (un `date` de la base llega a medianoche UTC). */
export function fechaDelContrato(fechaSalida: Date): string {
  return fechaSalida.toISOString().slice(0, 10);
}

export function armarRegistro(serviceId: string, datos: DatosStock): RegistroStock {
  return {
    service_id: serviceId,
    item_id: itemId(datos.numeroVuelo, datos.cabina),
    date: fechaDelContrato(datos.fechaSalida),
    time_slot: timeSlot(datos.salidaProgramada, datos.zonaHoraria),
    available_units: datos.unidades,
  };
}
