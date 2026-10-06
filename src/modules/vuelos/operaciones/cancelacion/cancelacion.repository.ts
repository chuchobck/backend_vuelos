import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../../generated/prisma/client';
import { PrismaService, TransaccionVuelos } from '../../../../prisma/prisma.service';

/** Lo que cuenta para el reembolso de un itinerario vigente. */
export interface LineaReembolsable {
  itinerarioId: string;
  /** Base e impuestos pagados por el itinerario (para todos los pasajeros). */
  base: Prisma.Decimal;
  impuestos: Prisma.Decimal;
  /** Maletas adicionales con pago aprobado de ese itinerario. */
  equipaje: Prisma.Decimal;
  /** porcentaje_penalidad_cancelacion de la familia vendida. */
  porcentajePenalidad: Prisma.Decimal;
}

export interface CotizacionGuardada {
  id: string;
  reservaId: string;
  reembolso: Prisma.Decimal;
  penalidad: Prisma.Decimal;
  vence: Date;
  aceptada: Date | null;
  completada: Date | null;
}

/** Una cancelación aceptada que espera su reembolso (CANCELACION_PENDIENTE). */
export interface CancelacionPendiente {
  reservaId: string;
  cotizacionId: string;
  moneda: string;
}

/**
 * Cotizaciones de cancelación (cotizacion_cancelacion) y lo que la cancelación necesita leer y
 * bloquear. Las escrituras van en la transacción auditada del service.
 */
@Injectable()
export class CancelacionRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Itinerarios vigentes de la reserva con lo pagado y la penalidad de su familia. */
  lineas(reservaId: string): Promise<LineaReembolsable[]> {
    return this.prisma.db.$queryRaw<LineaReembolsable[]>`
      SELECT r.itinerario_id AS "itinerarioId", r.tarifa_base AS base, r.impuestos,
             COALESCE((SELECT SUM(q.cantidad * q.precio_unitario)
                         FROM vuelos.reserva_detalle_equipaje q
                         JOIN vuelos.reserva_detalle_pago g ON g.id = q.pago_id
                        WHERE q.reserva_itinerario_id = r.id AND g.estado = 'APROBADO'), 0)
               AS equipaje,
             f.porcentaje_penalidad_cancelacion AS "porcentajePenalidad"
        FROM vuelos.reserva_detalle_itinerario r
        JOIN vuelos.familia_tarifa f ON f.id = r.familia_tarifa_id
       WHERE r.reserva_id = ${reservaId}::uuid AND r.vigente
       ORDER BY r.orden`;
  }

  /** Pagos de la reserva que la Payment API todavía no resolvió (equipaje, cambio). */
  pagosPendientes(reservaId: string): Promise<number> {
    return this.prisma.db.reserva_detalle_pago.count({
      where: { reserva_id: reservaId, estado: 'PENDIENTE' },
    });
  }

  async crear(
    tx: TransaccionVuelos,
    cotizacion: {
      reservaId: string;
      reembolso: Prisma.Decimal;
      penalidad: Prisma.Decimal;
      creada: Date;
      vence: Date;
    },
  ): Promise<string> {
    const fila = await tx.cotizacion_cancelacion.create({
      data: {
        reserva_id: cotizacion.reservaId,
        monto_reembolso: cotizacion.reembolso,
        monto_penalidad: cotizacion.penalidad,
        fecha_creacion: cotizacion.creada,
        fecha_expiracion: cotizacion.vence,
      },
      select: { id: true },
    });
    return fila.id;
  }

  async leer(cotizacionId: string): Promise<CotizacionGuardada | null> {
    const fila = await this.prisma.db.cotizacion_cancelacion.findUnique({
      where: { id: cotizacionId },
    });
    return fila
      ? {
          id: fila.id,
          reservaId: fila.reserva_id,
          reembolso: fila.monto_reembolso,
          penalidad: fila.monto_penalidad,
          vence: fila.fecha_expiracion,
          aceptada: fila.fecha_aceptacion,
          completada: fila.fecha_completada,
        }
      : null;
  }

  /**
   * Borra (físicamente: cotizacion_cancelacion está en TABLAS_CON_BORRADO_FISICO) las
   * cotizaciones vencidas que nadie aceptó. Una aceptada es la cancelación y no se toca.
   */
  async purgarVencidas(ahora: Date): Promise<number> {
    const { count } = await this.prisma.db.cotizacion_cancelacion.deleteMany({
      where: { fecha_aceptacion: null, fecha_expiracion: { lt: ahora } },
    });
    return count;
  }

  /**
   * Acepta la cotización si sigue vigente y nadie la aceptó (UPDATE condicionado). El índice
   * uq_cotizacion_cancelacion_aceptada deja una sola aceptada por reserva.
   */
  async aceptar(
    tx: TransaccionVuelos,
    cotizacionId: string,
    ahora: Date,
    motivo: string | null,
  ): Promise<boolean> {
    const { count } = await tx.cotizacion_cancelacion.updateMany({
      where: { id: cotizacionId, fecha_aceptacion: null, fecha_expiracion: { gte: ahora } },
      data: { fecha_aceptacion: ahora, motivo },
    });
    return count === 1;
  }

  async completar(tx: TransaccionVuelos, cotizacionId: string, ahora: Date): Promise<void> {
    await tx.cotizacion_cancelacion.updateMany({
      where: { id: cotizacionId, fecha_completada: null },
      data: { fecha_completada: ahora },
    });
  }

  /** La referencia del pago de emisión: el reembolso devuelve ese pago. */
  async referenciaDeEmision(reservaId: string): Promise<string> {
    const fila = await this.prisma.db.reserva_detalle_pago.findFirstOrThrow({
      where: { reserva_id: reservaId, concepto: 'EMISION' },
      select: { referencia_pago: true },
    });
    return fila.referencia_pago;
  }

  /** Las cancelaciones aceptadas cuyo reembolso sigue pendiente. */
  pendientes(limite: number): Promise<CancelacionPendiente[]> {
    return this.prisma.db.$queryRaw<CancelacionPendiente[]>`
      SELECT rc.id AS "reservaId", c.id AS "cotizacionId", m.codigo_iso AS moneda
        FROM vuelos.reserva_cabecera rc
        JOIN vuelos.cotizacion_cancelacion c ON c.reserva_id = rc.id AND c.fecha_aceptacion IS NOT NULL
        JOIN vuelos.retencion_cabecera r     ON r.id = rc.retencion_id
        JOIN vuelos.moneda m                 ON m.id = r.moneda_id
       WHERE rc.estado = 'CANCELACION_PENDIENTE' AND c.fecha_completada IS NULL
       ORDER BY c.fecha_aceptacion, rc.id
       LIMIT ${limite}`;
  }
}
