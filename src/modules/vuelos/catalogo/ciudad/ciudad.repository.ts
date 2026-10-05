import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { Ejecutor, FiltroCatalogo, RepositorioCatalogo } from '../base/repositorio-catalogo';

const CON_PAIS = { pais: { select: { codigo_iso2: true, activo: true } } } as const;

export type FilaCiudad = Prisma.ciudadGetPayload<{ include: typeof CON_PAIS }>;

export interface FiltroCiudad extends FiltroCatalogo {
  codigoPais?: string;
}

@Injectable()
export class CiudadRepository extends RepositorioCatalogo<FilaCiudad, FiltroCiudad> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  claveDe(fila: FilaCiudad): string {
    return fila.id_publico;
  }

  async buscar(clave: string, db: Ejecutor = this.prisma.db): Promise<FilaCiudad | null> {
    if (!this.esUuid(clave)) return null;
    return db.ciudad.findUnique({ where: { id_publico: clave }, include: CON_PAIS });
  }

  listar(
    filtro: FiltroCiudad,
    despuesDe: FilaCiudad | null,
    cantidad: number,
  ): Promise<FilaCiudad[]> {
    return this.prisma.db.ciudad.findMany({
      where: {
        ...this.soloActivos(filtro),
        ...(filtro.codigoPais ? { pais: { codigo_iso2: filtro.codigoPais } } : {}),
        ...(despuesDe ? { id: { gt: despuesDe.id } } : {}),
      },
      include: CON_PAIS,
      orderBy: { id: 'asc' },
      take: cantidad,
    });
  }

  estaActiva(fila: FilaCiudad): boolean {
    return fila.activo;
  }

  async fijarActivo(fila: FilaCiudad, activo: boolean, tx: Ejecutor): Promise<void> {
    await tx.ciudad.update({ where: { id: fila.id }, data: { activo } });
  }

  /** Devuelve el id público de la ciudad nueva. */
  async insertar(
    datos: { paisId: bigint; nombre: string; zonaHoraria?: string },
    tx: Ejecutor,
  ): Promise<string> {
    const fila = await tx.ciudad.create({
      data: { pais_id: datos.paisId, nombre: datos.nombre, zona_horaria: datos.zonaHoraria },
      select: { id_publico: true },
    });
    return fila.id_publico;
  }

  async modificar(
    fila: FilaCiudad,
    datos: { nombre?: string; zonaHoraria?: string },
    tx: Ejecutor,
  ): Promise<void> {
    await tx.ciudad.update({
      where: { id: fila.id },
      data: { nombre: datos.nombre, zona_horaria: datos.zonaHoraria },
    });
  }

  contarAeropuertosActivos(fila: FilaCiudad, tx: Ejecutor): Promise<number> {
    return tx.aeropuerto.count({ where: { ciudad_id: fila.id, activo: true } });
  }
}
