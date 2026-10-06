import { Injectable } from '@nestjs/common';
import { tipo_codigo_barras } from '../../../../generated/prisma/client';
import { PrismaService, TransaccionVuelos } from '../../../../prisma/prisma.service';
import { PaseAbordar } from './pase-abordar.modelo';

interface FilaPase {
  codigo_pasajero: string;
  salida_id: string;
  asiento: string;
  grupo_abordaje: string | null;
  posicion_abordaje: string | null;
  codigo_barras: string;
  tipo_codigo_barras: tipo_codigo_barras;
}

/** Pases de abordar (pase_abordar): uno por check-in registrado de un pasajero con asiento. */
@Injectable()
export class PaseAbordarRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Guarda el pase del check-in, en la transacción que lo registró. */
  async crear(
    tx: TransaccionVuelos,
    pase: {
      checkinId: bigint;
      grupo: string;
      posicion: string;
      codigoBarras: string;
      tipo: tipo_codigo_barras;
      emitido: Date;
    },
  ): Promise<void> {
    await tx.pase_abordar.create({
      data: {
        checkin_id: pase.checkinId,
        grupo_abordaje: pase.grupo,
        posicion_abordaje: pase.posicion,
        codigo_barras: pase.codigoBarras,
        tipo_codigo_barras: pase.tipo,
        fecha_emision: pase.emitido,
      },
    });
  }

  /**
   * Los pases de la reserva: los de check-in registrado en vuelos de los itinerarios vigentes
   * (un cambio de fecha deja los viejos sin efecto), con el asiento que el pasajero tiene hoy
   * en ese vuelo. Por pasajero y, dentro de él, por hora de salida.
   */
  async deReserva(reservaId: string): Promise<PaseAbordar[]> {
    const filas = await this.prisma.db.$queryRaw<FilaPase[]>`
      SELECT p.codigo_pasajero, c.vuelo_programado_id AS salida_id,
             f.numero_fila::text || a.letra AS asiento, pa.grupo_abordaje, pa.posicion_abordaje,
             pa.codigo_barras, pa.tipo_codigo_barras::text AS tipo_codigo_barras
        FROM vuelos.pase_abordar pa
        JOIN vuelos.checkin c                    ON c.id = pa.checkin_id AND c.estado = 'REGISTRADO'
        JOIN vuelos.reserva_detalle_pasajero p   ON p.id = c.pasajero_id
        JOIN vuelos.vuelo_programado vp          ON vp.id = c.vuelo_programado_id
        JOIN vuelos.reserva_detalle_asiento ra   ON ra.pasajero_id = p.id
                                                AND ra.vuelo_programado_id = c.vuelo_programado_id
                                                AND ra.fecha_liberacion IS NULL
        JOIN vuelos.asiento a                    ON a.id = ra.asiento_id
        JOIN vuelos.mapa_asientos_detalle f      ON f.id = a.mapa_asientos_detalle_id
       WHERE p.reserva_id = ${reservaId}::uuid
         AND EXISTS (SELECT 1
                       FROM vuelos.reserva_detalle_itinerario r
                       JOIN vuelos.itinerario_detalle i ON i.itinerario_id = r.itinerario_id
                      WHERE r.reserva_id = p.reserva_id AND r.vigente
                        AND i.vuelo_programado_id = c.vuelo_programado_id)
       ORDER BY p.id, vp.salida_programada, vp.id`;
    return filas.map((f) => ({
      codigoPasajero: f.codigo_pasajero,
      salidaId: f.salida_id,
      asiento: f.asiento,
      grupo: f.grupo_abordaje,
      posicion: f.posicion_abordaje,
      codigoBarras: f.codigo_barras,
      tipoCodigoBarras: f.tipo_codigo_barras,
    }));
  }
}
