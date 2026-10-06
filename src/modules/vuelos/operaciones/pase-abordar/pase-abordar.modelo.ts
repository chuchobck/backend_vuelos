import { tipo_codigo_barras } from '../../../../generated/prisma/client';

/** Un pase de abordar (pase_abordar) con el asiento que el pasajero tiene en ese vuelo. */
export interface PaseAbordar {
  /** passengerId del contrato (codigo_pasajero). */
  codigoPasajero: string;
  /** vuelo_programado.id: el segmentId del contrato. */
  salidaId: string;
  /** Asiento (12A): lo asignado en la reserva, no se guarda en el pase. */
  asiento: string;
  grupo: string | null;
  posicion: string | null;
  codigoBarras: string;
  tipoCodigoBarras: tipo_codigo_barras;
}
