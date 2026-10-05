import { Injectable } from '@nestjs/common';
import { clase_cabina, posicion_asiento, Prisma } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { Ejecutor, FiltroCatalogo, RepositorioCatalogo } from '../base/repositorio-catalogo';

const CON_DISTRIBUCION = {
  aerolinea: { select: { codigo_iata: true, activo: true } },
  modelo_aeronave: { select: { codigo_iata: true, activo: true } },
  mapa_asientos_detalle: {
    orderBy: { numero_fila: 'asc' },
    include: { asiento: { orderBy: { letra: 'asc' } } },
  },
} as const;

export type FilaMapaAsientos = Prisma.mapa_asientos_cabeceraGetPayload<{
  include: typeof CON_DISTRIBUCION;
}>;

export interface FiltroMapaAsientos extends FiltroCatalogo {
  codigoAerolinea?: string;
  codigoModelo?: string;
}

/** Una fila de la distribución, ya en los valores de la base. */
export interface FilaNueva {
  numero: number;
  claseCabina: clase_cabina;
  espacioExtra: boolean;
  salidaEmergencia: boolean;
  asientos: Array<{ letra: string; posicion: posicion_asiento }>;
}

@Injectable()
export class MapaAsientosRepository extends RepositorioCatalogo<
  FilaMapaAsientos,
  FiltroMapaAsientos
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  claveDe(fila: FilaMapaAsientos): string {
    return fila.id_publico;
  }

  async buscar(clave: string, db: Ejecutor = this.prisma.db): Promise<FilaMapaAsientos | null> {
    if (!this.esUuid(clave)) return null;
    return db.mapa_asientos_cabecera.findUnique({
      where: { id_publico: clave },
      include: CON_DISTRIBUCION,
    });
  }

  listar(
    filtro: FiltroMapaAsientos,
    despuesDe: FilaMapaAsientos | null,
    cantidad: number,
  ): Promise<FilaMapaAsientos[]> {
    return this.prisma.db.mapa_asientos_cabecera.findMany({
      where: {
        ...this.soloActivos(filtro),
        ...(filtro.codigoAerolinea ? { aerolinea: { codigo_iata: filtro.codigoAerolinea } } : {}),
        ...(filtro.codigoModelo ? { modelo_aeronave: { codigo_iata: filtro.codigoModelo } } : {}),
        ...(despuesDe ? { id: { gt: despuesDe.id } } : {}),
      },
      include: CON_DISTRIBUCION,
      orderBy: { id: 'asc' },
      take: cantidad,
    });
  }

  estaActiva(fila: FilaMapaAsientos): boolean {
    return fila.activo;
  }

  async fijarActivo(fila: FilaMapaAsientos, activo: boolean, tx: Ejecutor): Promise<void> {
    await tx.mapa_asientos_cabecera.update({ where: { id: fila.id }, data: { activo } });
  }

  /** La cabecera con sus filas y asientos, en una sola transacción. Devuelve el id público. */
  async insertar(
    datos: { aerolineaId: bigint; modeloId: bigint; nombre: string; filas: FilaNueva[] },
    tx: Ejecutor,
  ): Promise<string> {
    const mapa = await tx.mapa_asientos_cabecera.create({
      data: {
        aerolinea_id: datos.aerolineaId,
        modelo_aeronave_id: datos.modeloId,
        nombre: datos.nombre,
        mapa_asientos_detalle: {
          create: datos.filas.map((fila) => ({
            numero_fila: fila.numero,
            clase_cabina: fila.claseCabina,
            espacio_extra: fila.espacioExtra,
            salida_emergencia: fila.salidaEmergencia,
            asiento: { create: fila.asientos },
          })),
        },
      },
      select: { id_publico: true },
    });
    return mapa.id_publico;
  }

  async modificar(fila: FilaMapaAsientos, datos: { nombre?: string }, tx: Ejecutor): Promise<void> {
    await tx.mapa_asientos_cabecera.update({
      where: { id: fila.id },
      data: { nombre: datos.nombre },
    });
  }

  /** Salidas que usan el mapa y todavía no despegan ni se cancelaron. */
  contarSalidasProximas(fila: FilaMapaAsientos, tx: Ejecutor): Promise<number> {
    return tx.vuelo_programado.count({
      where: {
        mapa_asientos_id: fila.id,
        estado: { not: 'CANCELADO' },
        salida_programada: { gt: new Date() },
      },
    });
  }
}
