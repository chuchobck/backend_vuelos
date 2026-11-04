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
  /** El instante de salida (UTC). `date` y `time_slot` salen de aquí, en la zona de Booking. */
  salidaProgramada: Date;
  /** El cupo disponible ahora; 0 si la salida está cancelada. */
  unidades: number;
}

/** item_id = <número de vuelo>-<CABINA EN MAYÚSCULAS> con el nombre de cabina del contrato: AV1632-ECONOMY. */
export function itemId(numeroVuelo: string, cabina: clase_cabina): string {
  return `${numeroVuelo}-${CABINA.aContrato(cabina)}`;
}

/**
 * `date` y `time_slot`, confirmados por Booking: la hora REAL de salida en hora de Ecuador
 * (`BOOKING_STOCK_TZ`, America/Guayaquil por defecto: UTC-5 y sin horario de verano), que Booking
 * toma tal cual, sin convertirla. Salen los dos del MISMO instante de salida (UTC) convertido a esa
 * zona, en este único lugar: ni la zona ni la fecha del aeropuerto de origen cuentan (un vuelo de
 * Galápagos, UTC-6, sale una hora "adelante" en Ecuador continental, y cerca de medianoche la
 * fecha en Ecuador puede ser la del día anterior o siguiente a la del aeropuerto).
 */
export function fechaYHora(
  salidaProgramada: Date,
  zonaHoraria: string,
): { date: string; time_slot: string } {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: zonaHoraria,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(salidaProgramada);
  const de = (tipo: string) => partes.find((p) => p.type === tipo)?.value ?? '00';
  return {
    date: `${de('year')}-${de('month')}-${de('day')}`,
    time_slot: `${de('hour')}:${de('minute')}`,
  };
}

export function armarRegistro(
  serviceId: string,
  datos: DatosStock,
  zonaHoraria: string,
): RegistroStock {
  return {
    service_id: serviceId,
    item_id: itemId(datos.numeroVuelo, datos.cabina),
    ...fechaYHora(datos.salidaProgramada, zonaHoraria),
    available_units: datos.unidades,
  };
}
