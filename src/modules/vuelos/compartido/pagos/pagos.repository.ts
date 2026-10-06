import { Injectable } from '@nestjs/common';
import { concepto_pago, estado_pago } from '../../../../generated/prisma/client';
import { PrismaService, TransaccionVuelos } from '../../../../prisma/prisma.service';

export interface PagoNuevo {
  reservaId: string;
  referencia: string;
  concepto: concepto_pago;
  estado: estado_pago;
  fecha: Date;
}

/**
 * Las referencias de pago de una reserva (reserva_detalle_pago) y su estado en la Payment API.
 * Las registran la reserva (EMISION), el equipaje (EQUIPAJE_ADICIONAL) y el cambio de fecha
 * (CAMBIO_FECHA), siempre dentro de su transacción auditada. Nunca datos de tarjeta ni montos:
 * el monto lo guarda la operación que el pago acredita.
 */
@Injectable()
export class PagosRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Si la referencia ya acreditó otra operación (es única en todo el sistema). */
  async referenciaUsada(referencia: string): Promise<boolean> {
    return (
      (await this.prisma.db.reserva_detalle_pago.count({
        where: { referencia_pago: referencia },
      })) > 0
    );
  }

  /** Registra la referencia con el estado que dio la Payment API. Devuelve su id interno. */
  async registrar(tx: TransaccionVuelos, pago: PagoNuevo): Promise<bigint> {
    const fila = await tx.reserva_detalle_pago.create({
      data: {
        reserva_id: pago.reservaId,
        referencia_pago: pago.referencia,
        concepto: pago.concepto,
        estado: pago.estado,
        fecha_registro: pago.fecha,
      },
      select: { id: true },
    });
    return fila.id;
  }

  /** Resuelve un pago PENDIENTE (UPDATE condicionado). Devuelve si lo cambió. */
  async resolver(tx: TransaccionVuelos, pagoId: bigint, estado: estado_pago): Promise<boolean> {
    const { count } = await tx.reserva_detalle_pago.updateMany({
      where: { id: pagoId, estado: 'PENDIENTE' },
      data: { estado },
    });
    return count === 1;
  }

  /** El pago de emisión de la reserva. */
  async deEmision(tx: TransaccionVuelos, reservaId: string): Promise<bigint> {
    const fila = await tx.reserva_detalle_pago.findFirstOrThrow({
      where: { reserva_id: reservaId, concepto: 'EMISION' },
      select: { id: true },
    });
    return fila.id;
  }
}
