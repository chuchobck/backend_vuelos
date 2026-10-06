import { Injectable } from '@nestjs/common';
import { clase_cabina, estado_cambio, Prisma } from '../../../../generated/prisma/client';
import { PrismaService, TransaccionVuelos } from '../../../../prisma/prisma.service';

/** Una oferta de cambio que se guarda (cambio_cabecera OFERTADO y sus cambio_detalle). */
export interface OfertaCambioNueva {
  id: string;
  reservaId: string;
  cargo: Prisma.Decimal;
  creada: Date;
  vence: Date;
  detalles: Array<{
    lineaId: bigint;
    itinerarioNuevoId: string;
    diferenciaTarifa: Prisma.Decimal;
    diferenciaImpuestos: Prisma.Decimal;
  }>;
}

/** Una oferta de cambio leída para confirmarla. */
export interface OfertaCambio {
  id: string;
  reservaId: string;
  estado: estado_cambio;
  cargo: Prisma.Decimal;
  vence: Date;
  pagoId: bigint | null;
  detalles: Array<{
    lineaId: bigint;
    /** itinerario de la reserva que se reemplaza */
    itinerarioViejoId: string;
    orden: number;
    familiaId: bigint;
    cabina: clase_cabina;
    base: Prisma.Decimal;
    impuestos: Prisma.Decimal;
    itinerarioNuevoId: string;
    diferenciaTarifa: Prisma.Decimal;
    diferenciaImpuestos: Prisma.Decimal;
    /** vuelos del itinerario nuevo, en orden */
    salidasNuevas: Array<{ id: string; salida: Date; estado: string }>;
    /** vuelos del itinerario viejo, en orden */
    salidasViejas: string[];
  }>;
}

/** Un cambio con pago PENDIENTE (CAMBIO_PENDIENTE), para el proceso periódico. */
export interface CambioPendiente {
  cambioId: string;
  reservaId: string;
  pagoId: bigint;
  referencia: string;
}

/**
 * Ofertas de cambio de fecha (cambio_cabecera y cambio_detalle) y lo que el cambio necesita
 * escribir en la reserva: líneas de itinerario y equipaje. El cupo y los asientos van por la
 * reserva y el inventario. Todo dentro de la transacción auditada del service.
 */
@Injectable()
export class CambioFechaRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** id interno de la línea vigente de ese itinerario. */
  async lineaVigente(reservaId: string, itinerarioId: string): Promise<bigint | null> {
    const fila = await this.prisma.db.reserva_detalle_itinerario.findFirst({
      where: { reserva_id: reservaId, itinerario_id: itinerarioId, vigente: true },
      select: { id: true },
    });
    return fila?.id ?? null;
  }

  /**
   * changeFee de una persona: la suma del `cargo_cambio` de las tarifas del itinerario que se
   * reemplaza (la familia vendida en cada uno de sus vuelos).
   */
  async cargoPorPersona(lineaId: bigint): Promise<Prisma.Decimal> {
    const [fila] = await this.prisma.db.$queryRaw<Array<{ cargo: Prisma.Decimal | null }>>`
      SELECT SUM(t.cargo_cambio) AS cargo
        FROM vuelos.reserva_detalle_itinerario r
        JOIN vuelos.itinerario_detalle i ON i.itinerario_id = r.itinerario_id
        JOIN vuelos.tarifa_cabecera t    ON t.vuelo_programado_id = i.vuelo_programado_id
                                        AND t.familia_tarifa_id = r.familia_tarifa_id
       WHERE r.id = ${lineaId}`;
    return fila?.cargo ?? new Prisma.Decimal(0);
  }

  async guardarOfertas(tx: TransaccionVuelos, ofertas: OfertaCambioNueva[]): Promise<void> {
    if (ofertas.length === 0) return;
    await tx.cambio_cabecera.createMany({
      data: ofertas.map((o) => ({
        id: o.id,
        reserva_id: o.reservaId,
        estado: 'OFERTADO' as const,
        cargo_cambio: o.cargo,
        fecha_creacion: o.creada,
        fecha_expiracion: o.vence,
      })),
    });
    await tx.cambio_detalle.createMany({
      data: ofertas.flatMap((o) =>
        o.detalles.map((d) => ({
          cambio_id: o.id,
          reserva_itinerario_id: d.lineaId,
          itinerario_nuevo_id: d.itinerarioNuevoId,
          diferencia_tarifa: d.diferenciaTarifa,
          diferencia_impuestos: d.diferenciaImpuestos,
        })),
      ),
    });
  }

  /**
   * Borra (físicamente: cambio_cabecera y cambio_detalle están en TABLAS_CON_BORRADO_FISICO)
   * las ofertas de cambio vencidas que nadie confirmó; sus detalles caen en cascada. Una
   * confirmada, pendiente o fallida es parte de la reserva y no se toca. Los itinerarios que
   * queden sin uso los purga la búsqueda.
   */
  async purgarVencidas(ahora: Date): Promise<number> {
    const { count } = await this.prisma.db.cambio_cabecera.deleteMany({
      where: { estado: 'OFERTADO', fecha_expiracion: { lt: ahora } },
    });
    return count;
  }

  /** La oferta con sus detalles y los vuelos viejos y nuevos, o null si no existe. */
  async leer(cambioId: string): Promise<OfertaCambio | null> {
    const cambio = await this.prisma.db.cambio_cabecera.findUnique({
      where: { id: cambioId },
      include: {
        cambio_detalle: {
          include: {
            reserva_detalle_itinerario: {
              include: {
                familia_tarifa: { select: { clase_cabina: true } },
                itinerario_cabecera: {
                  select: {
                    itinerario_detalle: {
                      orderBy: { orden: 'asc' },
                      select: { vuelo_programado_id: true },
                    },
                  },
                },
              },
            },
            itinerario_cabecera: {
              select: {
                itinerario_detalle: {
                  orderBy: { orden: 'asc' },
                  select: {
                    vuelo_programado: {
                      select: { id: true, salida_programada: true, estado: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!cambio) return null;
    return {
      id: cambio.id,
      reservaId: cambio.reserva_id,
      estado: cambio.estado,
      cargo: cambio.cargo_cambio,
      vence: cambio.fecha_expiracion,
      pagoId: cambio.pago_id,
      detalles: cambio.cambio_detalle
        .map((d) => {
          const linea = d.reserva_detalle_itinerario;
          return {
            lineaId: linea.id,
            itinerarioViejoId: linea.itinerario_id,
            orden: linea.orden,
            familiaId: linea.familia_tarifa_id,
            cabina: linea.familia_tarifa.clase_cabina,
            base: linea.tarifa_base,
            impuestos: linea.impuestos,
            itinerarioNuevoId: d.itinerario_nuevo_id,
            diferenciaTarifa: d.diferencia_tarifa,
            diferenciaImpuestos: d.diferencia_impuestos,
            salidasNuevas: d.itinerario_cabecera.itinerario_detalle.map(
              ({ vuelo_programado: v }) => ({
                id: v.id,
                salida: v.salida_programada,
                estado: v.estado,
              }),
            ),
            salidasViejas: linea.itinerario_cabecera.itinerario_detalle.map(
              (s) => s.vuelo_programado_id,
            ),
          };
        })
        .sort((a, b) => a.orden - b.orden),
    };
  }

  /**
   * Pasa la oferta de `desde` a `hacia` (UPDATE condicionado, y si sigue vigente cuando sale de
   * OFERTADO). Devuelve si la cambió: dos confirmaciones de la misma oferta, una sola gana.
   */
  async cambiarEstado(
    tx: TransaccionVuelos,
    cambioId: string,
    desde: estado_cambio,
    hacia: estado_cambio,
    ahora: Date,
    pagoId?: bigint,
  ): Promise<boolean> {
    const resuelto = hacia !== 'OFERTADO' && hacia !== 'PENDIENTE';
    const { count } = await tx.cambio_cabecera.updateMany({
      where: {
        id: cambioId,
        estado: desde,
        ...(desde === 'OFERTADO' ? { fecha_expiracion: { gt: ahora } } : {}),
      },
      data: {
        estado: hacia,
        fecha_resolucion: resuelto ? ahora : null,
        ...(pagoId !== undefined ? { pago_id: pagoId } : {}),
      },
    });
    return count === 1;
  }

  /**
   * Agrega las líneas nuevas de la reserva, apagadas (vigente = false) hasta que el cambio se
   * confirme: un cambio con pago pendiente ya tiene sus vuelos, pero todavía no los vuela.
   */
  async agregarLineas(
    tx: TransaccionVuelos,
    reservaId: string,
    lineas: Array<{
      itinerarioId: string;
      familiaId: bigint;
      orden: number;
      base: Prisma.Decimal;
      impuestos: Prisma.Decimal;
    }>,
  ): Promise<void> {
    await tx.reserva_detalle_itinerario.createMany({
      data: lineas.map((l) => ({
        reserva_id: reservaId,
        itinerario_id: l.itinerarioId,
        familia_tarifa_id: l.familiaId,
        orden: l.orden,
        tarifa_base: l.base,
        impuestos: l.impuestos,
        vigente: false,
      })),
    });
  }

  /**
   * Confirma el cambio en la reserva: apaga las líneas viejas, enciende las nuevas (en ese
   * orden, por uq_reserva_detalle_itinerario_orden_vigente) y pasa a las nuevas las maletas
   * adicionales compradas para las viejas.
   */
  async activarLineas(
    tx: TransaccionVuelos,
    reservaId: string,
    pares: Array<{ lineaViejaId: bigint; itinerarioNuevoId: string }>,
  ): Promise<void> {
    await tx.reserva_detalle_itinerario.updateMany({
      where: { id: { in: pares.map((p) => p.lineaViejaId) } },
      data: { vigente: false },
    });
    for (const par of pares) {
      const nueva = await tx.reserva_detalle_itinerario.findFirstOrThrow({
        where: { reserva_id: reservaId, itinerario_id: par.itinerarioNuevoId },
        select: { id: true },
      });
      await tx.reserva_detalle_itinerario.update({
        where: { id: nueva.id },
        data: { vigente: true },
      });
      await tx.reserva_detalle_equipaje.updateMany({
        where: { reserva_itinerario_id: par.lineaViejaId },
        data: { reserva_itinerario_id: nueva.id },
      });
    }
  }

  /** Los cambios con pago PENDIENTE, los más viejos primero. */
  pendientes(limite: number): Promise<CambioPendiente[]> {
    return this.prisma.db.$queryRaw<CambioPendiente[]>`
      SELECT c.id AS "cambioId", c.reserva_id AS "reservaId", g.id AS "pagoId",
             g.referencia_pago AS referencia
        FROM vuelos.cambio_cabecera c
        JOIN vuelos.reserva_detalle_pago g ON g.id = c.pago_id
       WHERE c.estado = 'PENDIENTE' AND g.estado = 'PENDIENTE'
       ORDER BY c.fecha_creacion, c.id
       LIMIT ${limite}`;
  }
}
