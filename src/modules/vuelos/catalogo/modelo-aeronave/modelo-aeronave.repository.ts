import { Injectable } from '@nestjs/common';
import { modelo_aeronave } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { Ejecutor, FiltroCatalogo, RepositorioCatalogo } from '../base/repositorio-catalogo';

export type FilaModeloAeronave = modelo_aeronave;

@Injectable()
export class ModeloAeronaveRepository extends RepositorioCatalogo<FilaModeloAeronave> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  claveDe(fila: FilaModeloAeronave): string {
    return fila.codigo_iata;
  }

  buscar(clave: string, db: Ejecutor = this.prisma.db): Promise<FilaModeloAeronave | null> {
    return db.modelo_aeronave.findUnique({ where: { codigo_iata: clave } });
  }

  listar(
    filtro: FiltroCatalogo,
    despuesDe: FilaModeloAeronave | null,
    cantidad: number,
  ): Promise<FilaModeloAeronave[]> {
    return this.prisma.db.modelo_aeronave.findMany({
      where: { ...this.soloActivos(filtro), ...(despuesDe ? { id: { gt: despuesDe.id } } : {}) },
      orderBy: { id: 'asc' },
      take: cantidad,
    });
  }

  estaActiva(fila: FilaModeloAeronave): boolean {
    return fila.activo;
  }

  async fijarActivo(fila: FilaModeloAeronave, activo: boolean, tx: Ejecutor): Promise<void> {
    await tx.modelo_aeronave.update({ where: { id: fila.id }, data: { activo } });
  }

  async insertar(datos: { codigoIata: string; nombre: string }, tx: Ejecutor): Promise<void> {
    await tx.modelo_aeronave.create({
      data: { codigo_iata: datos.codigoIata, nombre: datos.nombre },
    });
  }

  async modificar(
    fila: FilaModeloAeronave,
    datos: { nombre?: string },
    tx: Ejecutor,
  ): Promise<void> {
    await tx.modelo_aeronave.update({ where: { id: fila.id }, data: { nombre: datos.nombre } });
  }

  contarMapasActivos(fila: FilaModeloAeronave, tx: Ejecutor): Promise<number> {
    return tx.mapa_asientos_cabecera.count({
      where: { modelo_aeronave_id: fila.id, activo: true },
    });
  }
}
