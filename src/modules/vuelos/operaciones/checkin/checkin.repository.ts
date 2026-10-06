import { Injectable } from '@nestjs/common';
import { PrismaService, TransaccionVuelos } from '../../../../prisma/prisma.service';

/** Un check-in registrado: el pasajero (passengerId) en un vuelo (segmentId). */
export interface CheckinRegistrado {
  codigoPasajero: string;
  salidaId: string;
}

/**
 * Check-in de pasajeros (checkin). Solo se guardan los REGISTRADO: que un segmento no abra
 * todavía o ya haya cerrado se calcula con la hora y el estado del vuelo, así repetir el
 * check-in no deja filas de más. El índice único uq_checkin_registrado (pasajero, vuelo) donde
 * estado = REGISTRADO deja un solo registro por pasajero y vuelo aunque dos peticiones lleguen
 * a la vez.
 */
@Injectable()
export class CheckinRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Los check-in registrados de los pasajeros de la reserva. */
  registrados(reservaId: string): Promise<CheckinRegistrado[]> {
    return this.prisma.db.$queryRaw<CheckinRegistrado[]>`
      SELECT p.codigo_pasajero AS "codigoPasajero", c.vuelo_programado_id AS "salidaId"
        FROM vuelos.checkin c
        JOIN vuelos.reserva_detalle_pasajero p ON p.id = c.pasajero_id
       WHERE p.reserva_id = ${reservaId}::uuid AND c.estado = 'REGISTRADO'`;
  }

  /** Lo mismo, dentro de la transacción que ya bloqueó la reserva. */
  registradosEn(tx: TransaccionVuelos, reservaId: string): Promise<CheckinRegistrado[]> {
    return tx.$queryRaw<CheckinRegistrado[]>`
      SELECT p.codigo_pasajero AS "codigoPasajero", c.vuelo_programado_id AS "salidaId"
        FROM vuelos.checkin c
        JOIN vuelos.reserva_detalle_pasajero p ON p.id = c.pasajero_id
       WHERE p.reserva_id = ${reservaId}::uuid AND c.estado = 'REGISTRADO'`;
  }

  /**
   * Registra el check-in de un pasajero en un vuelo. Devuelve el id del registro nuevo, o null
   * si ya estaba registrado (ON CONFLICT DO NOTHING: no cambia nada del registro anterior).
   */
  async registrar(
    tx: TransaccionVuelos,
    reservaId: string,
    codigoPasajero: string,
    salidaId: string,
    ahora: Date,
  ): Promise<bigint | null> {
    const [fila] = await tx.$queryRaw<Array<{ id: bigint }>>`
      INSERT INTO vuelos.checkin (pasajero_id, vuelo_programado_id, estado, fecha_registro)
      SELECT p.id, ${salidaId}::uuid, 'REGISTRADO', ${ahora}::timestamptz
        FROM vuelos.reserva_detalle_pasajero p
       WHERE p.reserva_id = ${reservaId}::uuid AND p.codigo_pasajero = ${codigoPasajero}
      ON CONFLICT (pasajero_id, vuelo_programado_id) WHERE estado = 'REGISTRADO' DO NOTHING
      RETURNING id`;
    return fila?.id ?? null;
  }
}
