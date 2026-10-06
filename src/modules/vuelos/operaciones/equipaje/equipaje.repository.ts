import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../../generated/prisma/client';
import { PrismaService, TransaccionVuelos } from '../../../../prisma/prisma.service';

/** Una compra de maletas con su pago pendiente, para el proceso periódico. */
export interface CompraPendiente {
  pagoId: bigint;
  referencia: string;
  reservaId: string;
}

/**
 * Maletas adicionales (reserva_detalle_equipaje). Las escrituras corren en la transacción
 * auditada del service; una compra bloquea antes la fila del pasajero, así dos compras del
 * mismo pasajero se esperan y la segunda cuenta las maletas de la primera.
 */
@Injectable()
export class EquipajeRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** id interno del pasajero de la reserva, con su fila bloqueada hasta el fin de la transacción. */
  async bloquearPasajero(
    tx: TransaccionVuelos,
    reservaId: string,
    codigo: string,
  ): Promise<bigint | null> {
    const [fila] = await tx.$queryRaw<Array<{ id: bigint }>>`
      SELECT id FROM vuelos.reserva_detalle_pasajero
       WHERE reserva_id = ${reservaId}::uuid AND codigo_pasajero = ${codigo}
         FOR UPDATE`;
    return fila?.id ?? null;
  }

  /** id interno de la línea vigente de ese itinerario en la reserva. */
  async lineaVigente(
    tx: TransaccionVuelos,
    reservaId: string,
    itinerarioId: string,
  ): Promise<bigint | null> {
    const fila = await tx.reserva_detalle_itinerario.findFirst({
      where: { reserva_id: reservaId, itinerario_id: itinerarioId, vigente: true },
      select: { id: true },
    });
    return fila?.id ?? null;
  }

  /** Maletas del pasajero en esa línea, con pago aprobado o pendiente (las rechazadas no). */
  async compradas(tx: TransaccionVuelos, pasajeroId: bigint, lineaId: bigint): Promise<number> {
    const { _sum } = await tx.reserva_detalle_equipaje.aggregate({
      where: {
        pasajero_id: pasajeroId,
        reserva_itinerario_id: lineaId,
        reserva_detalle_pago: { estado: { not: 'RECHAZADO' } },
      },
      _sum: { cantidad: true },
    });
    return _sum.cantidad ?? 0;
  }

  async registrar(
    tx: TransaccionVuelos,
    compra: {
      pasajeroId: bigint;
      lineaId: bigint;
      pagoId: bigint;
      cantidad: number;
      precioUnitario: Prisma.Decimal;
      fecha: Date;
    },
  ): Promise<void> {
    await tx.reserva_detalle_equipaje.create({
      data: {
        pasajero_id: compra.pasajeroId,
        reserva_itinerario_id: compra.lineaId,
        pago_id: compra.pagoId,
        cantidad: compra.cantidad,
        precio_unitario: compra.precioUnitario,
        fecha_registro: compra.fecha,
      },
    });
  }

  /** Las compras con pago PENDIENTE, las más viejas primero. */
  pendientes(limite: number): Promise<CompraPendiente[]> {
    return this.prisma.db.$queryRaw<CompraPendiente[]>`
      SELECT g.id AS "pagoId", g.referencia_pago AS referencia, g.reserva_id AS "reservaId"
        FROM vuelos.reserva_detalle_pago g
       WHERE g.concepto = 'EQUIPAJE_ADICIONAL' AND g.estado = 'PENDIENTE'
       ORDER BY g.fecha_registro, g.id
       LIMIT ${limite}`;
  }

  /** Bloquea el pago si sigue PENDIENTE (SKIP LOCKED: otro proceso ya lo tiene). */
  async tomarPendiente(tx: TransaccionVuelos, pagoId: bigint): Promise<boolean> {
    const filas = await tx.$queryRaw<unknown[]>`
      SELECT 1 FROM vuelos.reserva_detalle_pago
       WHERE id = ${pagoId} AND estado = 'PENDIENTE'
         FOR UPDATE SKIP LOCKED`;
    return filas.length === 1;
  }

  /** La compra de ese pago: pasajero (passengerId), itinerario y cantidad. */
  async deCompra(
    tx: TransaccionVuelos,
    pagoId: bigint,
  ): Promise<{ codigoPasajero: string; itinerarioId: string; cantidad: number }> {
    const [fila] = await tx.$queryRaw<
      Array<{ codigoPasajero: string; itinerarioId: string; cantidad: number }>
    >`
      SELECT p.codigo_pasajero AS "codigoPasajero", r.itinerario_id AS "itinerarioId",
             q.cantidad::int AS cantidad
        FROM vuelos.reserva_detalle_equipaje q
        JOIN vuelos.reserva_detalle_pasajero p   ON p.id = q.pasajero_id
        JOIN vuelos.reserva_detalle_itinerario r ON r.id = q.reserva_itinerario_id
       WHERE q.pago_id = ${pagoId}`;
    return fila;
  }
}
