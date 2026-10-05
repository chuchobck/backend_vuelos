import { Injectable } from '@nestjs/common';
import { clase_cabina, estado_vuelo, Prisma } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { Ejecutor, FiltroCatalogo, RepositorioCatalogo } from '../base/repositorio-catalogo';

const CON_DETALLE = {
  vuelo: {
    select: {
      numero: true,
      activo: true,
      aerolinea_vuelo_aerolinea_idToaerolinea: { select: { codigo_iata: true } },
      aeropuerto_vuelo_aeropuerto_origen_idToaeropuerto: {
        select: { codigo_iata: true, ciudad: { select: { zona_horaria: true } } },
      },
      aeropuerto_vuelo_aeropuerto_destino_idToaeropuerto: { select: { codigo_iata: true } },
    },
  },
  mapa_asientos_cabecera: {
    select: {
      id_publico: true,
      activo: true,
      modelo_aeronave: { select: { codigo_iata: true } },
    },
  },
  inventario_cabina: { orderBy: { clase_cabina: 'asc' } },
} as const;

export type FilaVueloProgramado = Prisma.vuelo_programadoGetPayload<{
  include: typeof CON_DETALLE;
}>;

export function numeroVueloDeSalida(fila: FilaVueloProgramado): string {
  return `${fila.vuelo.aerolinea_vuelo_aerolinea_idToaerolinea.codigo_iata}${fila.vuelo.numero}`;
}

/** Estados en los que el avión ya salió: no se cancela ni se cambia el horario programado. */
export const ESTADOS_DESPEGADO: readonly estado_vuelo[] = ['DESPEGADO', 'ATERRIZADO', 'DESVIADO'];

export interface FiltroVueloProgramado extends FiltroCatalogo {
  numeroVuelo?: { aerolinea: string; numero: string };
  fechaDesde?: Date;
  fechaHasta?: Date;
  estado?: estado_vuelo;
}

export interface CupoNuevo {
  claseCabina: clase_cabina;
  total: number;
}

/** Columnas de una salida que se pueden modificar; null borra un valor opcional. */
export interface CambiosSalida {
  fechaSalida?: Date;
  salidaProgramada?: Date;
  llegadaProgramada?: Date;
  salidaEstimada?: Date | null;
  llegadaEstimada?: Date | null;
  salidaReal?: Date | null;
  llegadaReal?: Date | null;
  terminalSalida?: string | null;
  terminalLlegada?: string | null;
  estado?: estado_vuelo;
}

/** Lo que impide cancelar una salida: retenciones vigentes y reservas no canceladas. */
export interface CompromisosSalida {
  retenciones: number;
  reservas: number;
}

@Injectable()
export class VueloProgramadoRepository extends RepositorioCatalogo<
  FilaVueloProgramado,
  FiltroVueloProgramado
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  claveDe(fila: FilaVueloProgramado): string {
    return fila.id;
  }

  async buscar(clave: string, db: Ejecutor = this.prisma.db): Promise<FilaVueloProgramado | null> {
    if (!this.esUuid(clave)) return null;
    return db.vuelo_programado.findUnique({ where: { id: clave }, include: CON_DETALLE });
  }

  /**
   * Por hora de salida y, a igual hora, por id. Una salida cancelada es la "inactiva":
   * se oculta salvo que se pidan las inactivas o se filtre por ese estado.
   */
  listar(
    filtro: FiltroVueloProgramado,
    despuesDe: FilaVueloProgramado | null,
    cantidad: number,
  ): Promise<FilaVueloProgramado[]> {
    const condiciones: Prisma.vuelo_programadoWhereInput[] = [];
    if (filtro.estado) condiciones.push({ estado: filtro.estado });
    else if (!filtro.incluirInactivos) condiciones.push({ estado: { not: 'CANCELADO' } });
    if (filtro.numeroVuelo) {
      condiciones.push({
        vuelo: {
          numero: filtro.numeroVuelo.numero,
          aerolinea_vuelo_aerolinea_idToaerolinea: { codigo_iata: filtro.numeroVuelo.aerolinea },
        },
      });
    }
    if (filtro.fechaDesde) condiciones.push({ fecha_salida: { gte: filtro.fechaDesde } });
    if (filtro.fechaHasta) condiciones.push({ fecha_salida: { lte: filtro.fechaHasta } });
    if (despuesDe) {
      condiciones.push({
        OR: [
          { salida_programada: { gt: despuesDe.salida_programada } },
          { salida_programada: despuesDe.salida_programada, id: { gt: despuesDe.id } },
        ],
      });
    }
    return this.prisma.db.vuelo_programado.findMany({
      where: { AND: condiciones },
      include: CON_DETALLE,
      orderBy: [{ salida_programada: 'asc' }, { id: 'asc' }],
      take: cantidad,
    });
  }

  estaActiva(fila: FilaVueloProgramado): boolean {
    return fila.estado !== 'CANCELADO';
  }

  /** La baja de una salida es cancelarla; reactivarla la devuelve a PROGRAMADO. */
  async fijarActivo(fila: FilaVueloProgramado, activo: boolean, tx: Ejecutor): Promise<void> {
    await tx.vuelo_programado.update({
      where: { id: fila.id },
      data: { estado: activo ? 'PROGRAMADO' : 'CANCELADO' },
    });
  }

  /** La salida y sus cupos por cabina en una sola transacción. Devuelve el id (segmentId). */
  async insertar(
    datos: {
      vueloId: bigint;
      mapaId: bigint;
      fechaSalida: Date;
      salidaProgramada: Date;
      llegadaProgramada: Date;
      terminalSalida?: string | null;
      terminalLlegada?: string | null;
      cupos: CupoNuevo[];
    },
    tx: Ejecutor,
  ): Promise<string> {
    const fila = await tx.vuelo_programado.create({
      data: {
        vuelo_id: datos.vueloId,
        mapa_asientos_id: datos.mapaId,
        fecha_salida: datos.fechaSalida,
        salida_programada: datos.salidaProgramada,
        llegada_programada: datos.llegadaProgramada,
        terminal_salida: datos.terminalSalida,
        terminal_llegada: datos.terminalLlegada,
        inventario_cabina: {
          create: datos.cupos.map((cupo) => ({
            clase_cabina: cupo.claseCabina,
            cupos_totales: cupo.total,
            cupos_disponibles: cupo.total,
          })),
        },
      },
      select: { id: true },
    });
    return fila.id;
  }

  async modificar(fila: FilaVueloProgramado, cambios: CambiosSalida, tx: Ejecutor): Promise<void> {
    await tx.vuelo_programado.update({
      where: { id: fila.id },
      data: {
        fecha_salida: cambios.fechaSalida,
        salida_programada: cambios.salidaProgramada,
        llegada_programada: cambios.llegadaProgramada,
        salida_estimada: cambios.salidaEstimada,
        llegada_estimada: cambios.llegadaEstimada,
        salida_real: cambios.salidaReal,
        llegada_real: cambios.llegadaReal,
        terminal_salida: cambios.terminalSalida,
        terminal_llegada: cambios.terminalLlegada,
        estado: cambios.estado,
      },
    });
  }

  /**
   * Cambia el cupo total de una cabina sin perder lo ya retenido o vendido: los disponibles
   * se mueven lo mismo que el total. Es un solo UPDATE condicionado, así que una retención
   * que llegue al mismo tiempo no puede dejar `cupos_disponibles` negativo. Devuelve false
   * si el total nuevo queda por debajo de lo comprometido (y no cambia nada).
   */
  async ajustarCupo(
    vueloProgramadoId: string,
    claseCabina: clase_cabina,
    total: number,
    tx: Ejecutor,
  ): Promise<boolean> {
    const cambiadas = await tx.$executeRaw`
      UPDATE vuelos.inventario_cabina
         SET cupos_disponibles = cupos_disponibles + (${total}::smallint - cupos_totales),
             cupos_totales     = ${total}::smallint
       WHERE vuelo_programado_id = ${vueloProgramadoId}::uuid
         AND clase_cabina = ${claseCabina}::vuelos.clase_cabina
         AND ${total}::smallint >= cupos_totales - cupos_disponibles`;
    return cambiadas === 1;
  }

  async agregarCupo(vueloProgramadoId: string, cupo: CupoNuevo, tx: Ejecutor): Promise<void> {
    await tx.inventario_cabina.create({
      data: {
        vuelo_programado_id: vueloProgramadoId,
        clase_cabina: cupo.claseCabina,
        cupos_totales: cupo.total,
        cupos_disponibles: cupo.total,
      },
    });
  }

  /** Retenciones vigentes y reservas no canceladas con un itinerario que pasa por la salida. */
  async contarCompromisos(fila: FilaVueloProgramado, tx: Ejecutor): Promise<CompromisosSalida> {
    const pasaPorLaSalida = {
      itinerario_cabecera: { itinerario_detalle: { some: { vuelo_programado_id: fila.id } } },
    };
    const [retenciones, reservas] = await Promise.all([
      tx.retencion_cabecera.count({
        where: {
          estado: 'RETENIDA',
          fecha_expiracion: { gt: new Date() },
          retencion_detalle: { some: pasaPorLaSalida },
        },
      }),
      tx.reserva_cabecera.count({
        where: {
          estado: { notIn: ['CANCELADA', 'FALLIDA'] },
          reserva_detalle_itinerario: { some: { vigente: true, ...pasaPorLaSalida } },
        },
      }),
    ]);
    return { retenciones, reservas };
  }
}
