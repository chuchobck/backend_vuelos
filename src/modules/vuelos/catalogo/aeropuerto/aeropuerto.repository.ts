import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { Ejecutor, FiltroCatalogo, RepositorioCatalogo } from '../base/repositorio-catalogo';

const CON_CIUDAD = {
  ciudad: {
    select: {
      id_publico: true,
      nombre: true,
      activo: true,
      pais: { select: { codigo_iso2: true } },
    },
  },
} as const;

export type FilaAeropuerto = Prisma.aeropuertoGetPayload<{ include: typeof CON_CIUDAD }>;

export interface FiltroAeropuerto extends FiltroCatalogo {
  ciudadId?: string;
  codigoPais?: string;
}

@Injectable()
export class AeropuertoRepository extends RepositorioCatalogo<FilaAeropuerto, FiltroAeropuerto> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  claveDe(fila: FilaAeropuerto): string {
    return fila.codigo_iata;
  }

  buscar(clave: string, db: Ejecutor = this.prisma.db): Promise<FilaAeropuerto | null> {
    return db.aeropuerto.findUnique({ where: { codigo_iata: clave }, include: CON_CIUDAD });
  }

  listar(
    filtro: FiltroAeropuerto,
    despuesDe: FilaAeropuerto | null,
    cantidad: number,
  ): Promise<FilaAeropuerto[]> {
    return this.prisma.db.aeropuerto.findMany({
      where: {
        ...this.soloActivos(filtro),
        ciudad: {
          ...(filtro.ciudadId ? { id_publico: filtro.ciudadId } : {}),
          ...(filtro.codigoPais ? { pais: { codigo_iso2: filtro.codigoPais } } : {}),
        },
        ...(despuesDe ? { id: { gt: despuesDe.id } } : {}),
      },
      include: CON_CIUDAD,
      orderBy: { id: 'asc' },
      take: cantidad,
    });
  }

  estaActiva(fila: FilaAeropuerto): boolean {
    return fila.activo;
  }

  async fijarActivo(fila: FilaAeropuerto, activo: boolean, tx: Ejecutor): Promise<void> {
    await tx.aeropuerto.update({ where: { id: fila.id }, data: { activo } });
  }

  async insertar(
    datos: { codigoIata: string; nombre: string; ciudadId: bigint },
    tx: Ejecutor,
  ): Promise<void> {
    await tx.aeropuerto.create({
      data: { codigo_iata: datos.codigoIata, nombre: datos.nombre, ciudad_id: datos.ciudadId },
    });
  }

  async modificar(
    fila: FilaAeropuerto,
    datos: { nombre?: string; ciudadId?: bigint },
    tx: Ejecutor,
  ): Promise<void> {
    await tx.aeropuerto.update({
      where: { id: fila.id },
      data: { nombre: datos.nombre, ciudad_id: datos.ciudadId },
    });
  }

  /** Vuelos activos que salen de este aeropuerto o llegan a él. */
  contarVuelosActivos(fila: FilaAeropuerto, tx: Ejecutor): Promise<number> {
    return tx.vuelo.count({
      where: {
        activo: true,
        OR: [{ aeropuerto_origen_id: fila.id }, { aeropuerto_destino_id: fila.id }],
      },
    });
  }
}
