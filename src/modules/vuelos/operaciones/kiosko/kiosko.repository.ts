import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';

/** Lo mínimo de una reserva para decidir si el kiosko la puede abrir. */
export interface ReservaPorPnr {
  reservaId: string;
  /** El dueño de la reserva: con él se llama a los services de check-in y de pases. */
  idPropietario: string;
  /** Los apellidos de todos sus pasajeros, como se guardaron. */
  apellidos: string[];
}

/**
 * Lo único que el kiosko lee por su cuenta: a qué reserva corresponde un PNR y de quién es. Todo
 * lo demás (la reserva, el check-in, los pases) sale de los services de siempre.
 */
@Injectable()
export class KioskoRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** La reserva con ese PNR (es único) y los apellidos de sus pasajeros, o null. */
  async porPnr(pnr: string): Promise<ReservaPorPnr | null> {
    const filas = await this.prisma.db.$queryRaw<
      Array<{ id: string; id_propietario: string; apellidos: string }>
    >`
      SELECT rc.id, r.id_propietario, p.apellidos
        FROM vuelos.reserva_cabecera rc
        JOIN vuelos.retencion_cabecera r       ON r.id = rc.retencion_id
        JOIN vuelos.reserva_detalle_pasajero p ON p.reserva_id = rc.id
       WHERE rc.pnr = ${pnr}
       ORDER BY p.id`;
    if (filas.length === 0) return null;
    return {
      reservaId: filas[0].id,
      idPropietario: filas[0].id_propietario,
      apellidos: filas.map((f) => f.apellidos),
    };
  }

  /** El dueño de la reserva, o null si no existe. */
  async propietario(reservaId: string): Promise<string | null> {
    const [fila] = await this.prisma.db.$queryRaw<Array<{ id_propietario: string }>>`
      SELECT r.id_propietario
        FROM vuelos.reserva_cabecera rc
        JOIN vuelos.retencion_cabecera r ON r.id = rc.retencion_id
       WHERE rc.id = ${reservaId}::uuid`;
    return fila?.id_propietario ?? null;
  }
}
