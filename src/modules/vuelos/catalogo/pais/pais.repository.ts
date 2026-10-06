import { Injectable } from '@nestjs/common';
import { pais } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { Ejecutor, FiltroCatalogo, RepositorioCatalogo } from '../base/repositorio-catalogo';

export type FilaPais = pais;

@Injectable()
export class PaisRepository extends RepositorioCatalogo<FilaPais> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  claveDe(fila: FilaPais): string {
    return fila.codigo_iso2;
  }

  buscar(clave: string, db: Ejecutor = this.prisma.db): Promise<FilaPais | null> {
    return db.pais.findUnique({ where: { codigo_iso2: clave } });
  }

  listar(
    filtro: FiltroCatalogo,
    despuesDe: FilaPais | null,
    cantidad: number,
  ): Promise<FilaPais[]> {
    return this.prisma.db.pais.findMany({
      where: { ...this.soloActivos(filtro), ...(despuesDe ? { id: { gt: despuesDe.id } } : {}) },
      orderBy: { id: 'asc' },
      take: cantidad,
    });
  }

  estaActiva(fila: FilaPais): boolean {
    return fila.activo;
  }

  async fijarActivo(fila: FilaPais, activo: boolean, tx: Ejecutor): Promise<void> {
    await tx.pais.update({ where: { id: fila.id }, data: { activo } });
  }

  async insertar(
    datos: { codigoIso2: string; codigoIso3: string; nombre: string },
    tx: Ejecutor,
  ): Promise<void> {
    await tx.pais.create({
      data: { codigo_iso2: datos.codigoIso2, codigo_iso3: datos.codigoIso3, nombre: datos.nombre },
    });
  }

  async modificar(fila: FilaPais, datos: { nombre?: string }, tx: Ejecutor): Promise<void> {
    await tx.pais.update({ where: { id: fila.id }, data: { nombre: datos.nombre } });
  }

  contarCiudadesActivas(fila: FilaPais, tx: Ejecutor): Promise<number> {
    return tx.ciudad.count({ where: { pais_id: fila.id, activo: true } });
  }
}
