import { Injectable } from '@nestjs/common';
import { aerolinea } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { Ejecutor, FiltroCatalogo, RepositorioCatalogo } from '../base/repositorio-catalogo';

export type FilaAerolinea = aerolinea;

/** Lo que una aerolínea tiene activo y le impide darse de baja. */
export interface UsosAerolinea {
  vuelos: number;
  familias: number;
  mapas: number;
}

@Injectable()
export class AerolineaRepository extends RepositorioCatalogo<FilaAerolinea> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  claveDe(fila: FilaAerolinea): string {
    return fila.codigo_iata;
  }

  buscar(clave: string, db: Ejecutor = this.prisma.db): Promise<FilaAerolinea | null> {
    return db.aerolinea.findUnique({ where: { codigo_iata: clave } });
  }

  listar(
    filtro: FiltroCatalogo,
    despuesDe: FilaAerolinea | null,
    cantidad: number,
  ): Promise<FilaAerolinea[]> {
    return this.prisma.db.aerolinea.findMany({
      where: { ...this.soloActivos(filtro), ...(despuesDe ? { id: { gt: despuesDe.id } } : {}) },
      orderBy: { id: 'asc' },
      take: cantidad,
    });
  }

  estaActiva(fila: FilaAerolinea): boolean {
    return fila.activo;
  }

  async fijarActivo(fila: FilaAerolinea, activo: boolean, tx: Ejecutor): Promise<void> {
    await tx.aerolinea.update({ where: { id: fila.id }, data: { activo } });
  }

  async insertar(
    datos: { codigoIata: string; nombre: string; prefijoBoleto?: string },
    tx: Ejecutor,
  ): Promise<void> {
    await tx.aerolinea.create({
      data: {
        codigo_iata: datos.codigoIata,
        nombre: datos.nombre,
        prefijo_boleto: datos.prefijoBoleto,
      },
    });
  }

  async modificar(
    fila: FilaAerolinea,
    datos: { nombre?: string; prefijoBoleto?: string | null },
    tx: Ejecutor,
  ): Promise<void> {
    await tx.aerolinea.update({
      where: { id: fila.id },
      data: { nombre: datos.nombre, prefijo_boleto: datos.prefijoBoleto },
    });
  }

  /** Vuelos activos que comercializa u opera, y sus familias y mapas de asientos activos. */
  async contarUsosActivos(fila: FilaAerolinea, tx: Ejecutor): Promise<UsosAerolinea> {
    const [vuelos, familias, mapas] = await Promise.all([
      tx.vuelo.count({
        where: {
          activo: true,
          OR: [{ aerolinea_id: fila.id }, { aerolinea_operadora_id: fila.id }],
        },
      }),
      tx.familia_tarifa.count({ where: { aerolinea_id: fila.id, activo: true } }),
      tx.mapa_asientos_cabecera.count({ where: { aerolinea_id: fila.id, activo: true } }),
    ]);
    return { vuelos, familias, mapas };
  }
}
