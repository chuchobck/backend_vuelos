import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';

const CON_ASIENTOS = { asiento: { orderBy: { letra: 'asc' } } } as const;

export type FilaDistribucion = Prisma.mapa_asientos_detalleGetPayload<{
  include: typeof CON_ASIENTOS;
}>;

/** La salida de un segmento de la oferta, con lo que hace falta para su mapa. */
export interface SegmentoDeOferta {
  salidaId: string;
  mapaId: bigint;
  estado: Prisma.vuelo_programadoGetPayload<object>['estado'];
  salida: Date;
}

/** Lecturas del mapa de asientos de una oferta. No escribe nada. */
@Injectable()
export class OfertaRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** La fecha de vencimiento de la oferta, o null si no existe. */
  async vencimiento(ofertaId: string): Promise<Date | null> {
    const oferta = await this.prisma.db.oferta_cabecera.findUnique({
      where: { id: ofertaId },
      select: { fecha_expiracion: true },
    });
    return oferta?.fecha_expiracion ?? null;
  }

  /** La salida `segmentoId` si es un segmento de algún itinerario de la oferta; si no, null. */
  async segmento(ofertaId: string, segmentoId: string): Promise<SegmentoDeOferta | null> {
    const fila = await this.prisma.db.vuelo_programado.findFirst({
      where: {
        id: segmentoId,
        itinerario_detalle: {
          some: { itinerario_cabecera: { oferta_detalle: { some: { oferta_id: ofertaId } } } },
        },
      },
      select: { id: true, mapa_asientos_id: true, estado: true, salida_programada: true },
    });
    return fila
      ? {
          salidaId: fila.id,
          mapaId: fila.mapa_asientos_id,
          estado: fila.estado,
          salida: fila.salida_programada,
        }
      : null;
  }

  /** Filas y asientos físicos del mapa, en orden. */
  distribucion(mapaId: bigint): Promise<FilaDistribucion[]> {
    return this.prisma.db.mapa_asientos_detalle.findMany({
      where: { mapa_asientos_id: mapaId },
      include: CON_ASIENTOS,
      orderBy: { numero_fila: 'asc' },
    });
  }

  /** Asientos con una asignación vigente (no liberada) en una reserva de esta salida. */
  async asientosOcupados(salidaId: string): Promise<Set<bigint>> {
    const filas = await this.prisma.db.reserva_detalle_asiento.findMany({
      where: { vuelo_programado_id: salidaId, fecha_liberacion: null },
      select: { asiento_id: true },
    });
    return new Set(filas.map((f) => f.asiento_id));
  }

  /** Cabinas que se venden en la salida (con cupo total mayor que 0). */
  async cabinasVendidas(salidaId: string): Promise<Set<string>> {
    const filas = await this.prisma.db.inventario_cabina.findMany({
      where: { vuelo_programado_id: salidaId, cupos_totales: { gt: 0 } },
      select: { clase_cabina: true },
    });
    return new Set(filas.map((f) => f.clase_cabina));
  }
}
