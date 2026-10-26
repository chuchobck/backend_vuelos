import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

/** Lo que la fachada v2 suma al BookingDetail de v1. */
export interface DatosV2DeReserva {
  holdId: string;
  /** La referencia del pago de emisión (la que mandó Booking o la de la Payment API). */
  referenciaPago: string | null;
  proveedorPago: 'AEROLINEA' | 'BOOKING_PROTOTIPO' | null;
  canal: {
    socio: string | null;
    orden: string | null;
    paquete: string | null;
    promocion: boolean | null;
    descuento: number | null;
  };
}

/** El estado de un asiento ocupado en una salida (SeatStatus del contrato v2). */
export type EstadoAsientoOcupado = 'BOOKED' | 'TICKETED' | 'CHECKED_IN';

/**
 * Lecturas propias de la fachada v2 (el único archivo de v2 que usa Prisma): lo que el contrato
 * v2 agrega a las respuestas de v1 y el filtro por usuario final de un partner. No escribe.
 */
@Injectable()
export class FachadaV2Repository {
  constructor(private readonly prisma: PrismaService) {}

  /** El dueño y el usuario final (X-User-Id) de una reserva, o null si no existe. */
  async accesoReserva(
    reservaId: string,
  ): Promise<{ idPropietario: string; usuarioExterno: string | null } | null> {
    const [fila] = await this.prisma.db.$queryRaw<
      Array<{ id_propietario: string; id_usuario_externo: string | null }>
    >`
      SELECT r.id_propietario, rc.id_usuario_externo
        FROM vuelos.reserva_cabecera rc
        JOIN vuelos.retencion_cabecera r ON r.id = rc.retencion_id
       WHERE rc.id = ${reservaId}::uuid`;
    return fila
      ? { idPropietario: fila.id_propietario, usuarioExterno: fila.id_usuario_externo }
      : null;
  }

  async datosDeReserva(reservaId: string): Promise<DatosV2DeReserva> {
    const [fila] = await this.prisma.db.$queryRaw<
      Array<{
        retencion_id: string;
        referencia_pago: string | null;
        proveedor: 'AEROLINEA' | 'BOOKING_PROTOTIPO' | null;
        canal_socio: string | null;
        canal_orden: string | null;
        canal_paquete: string | null;
        canal_promocion: boolean | null;
        canal_descuento: string | null;
      }>
    >`
      SELECT rc.retencion_id::text AS retencion_id, p.referencia_pago, p.proveedor::text AS proveedor,
             rc.canal_socio, rc.canal_orden, rc.canal_paquete, rc.canal_promocion,
             rc.canal_descuento::text AS canal_descuento
        FROM vuelos.reserva_cabecera rc
        LEFT JOIN vuelos.reserva_detalle_pago p
               ON p.reserva_id = rc.id AND p.concepto = 'EMISION'
       WHERE rc.id = ${reservaId}::uuid`;
    return {
      holdId: fila.retencion_id,
      referenciaPago: fila.referencia_pago,
      proveedorPago: fila.proveedor,
      canal: {
        socio: fila.canal_socio,
        orden: fila.canal_orden,
        paquete: fila.canal_paquete,
        promocion: fila.canal_promocion,
        descuento: fila.canal_descuento === null ? null : Number(fila.canal_descuento),
      },
    };
  }

  /**
   * Los asientos ocupados de una salida y en qué punto están: CHECKED_IN si su pasajero hizo el
   * check-in de esa salida, TICKETED si tiene el boleto emitido, BOOKED si no.
   */
  async estadosDeAsientos(salidaId: string): Promise<Map<bigint, EstadoAsientoOcupado>> {
    const filas = await this.prisma.db.$queryRaw<
      Array<{ asiento_id: bigint; registrado: boolean; emitido: boolean }>
    >`
      SELECT ra.asiento_id,
             EXISTS (SELECT 1 FROM vuelos.checkin c
                      WHERE c.pasajero_id = ra.pasajero_id
                        AND c.vuelo_programado_id = ra.vuelo_programado_id
                        AND c.estado::text = 'REGISTRADO') AS registrado,
             EXISTS (SELECT 1 FROM vuelos.boleto_cabecera b
                      WHERE b.pasajero_id = ra.pasajero_id AND b.estado::text = 'EMITIDO') AS emitido
        FROM vuelos.reserva_detalle_asiento ra
       WHERE ra.vuelo_programado_id = ${salidaId}::uuid AND ra.fecha_liberacion IS NULL`;
    return new Map(
      filas.map((f) => [
        f.asiento_id,
        f.registrado ? 'CHECKED_IN' : f.emitido ? 'TICKETED' : 'BOOKED',
      ]),
    );
  }

  /** Asientos de la reserva que se liberaron en ese instante (los de su cancelación). */
  async asientosLiberados(reservaId: string, instante: Date): Promise<number> {
    const [fila] = await this.prisma.db.$queryRaw<Array<{ total: number }>>`
      SELECT count(*)::int AS total
        FROM vuelos.reserva_detalle_asiento ra
        JOIN vuelos.reserva_detalle_pasajero p ON p.id = ra.pasajero_id
       WHERE p.reserva_id = ${reservaId}::uuid AND ra.fecha_liberacion = ${instante}::timestamptz`;
    return fila.total;
  }
}
