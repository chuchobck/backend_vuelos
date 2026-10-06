import { Injectable } from '@nestjs/common';
import { clase_cabina, Prisma } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { Ejecutor, FiltroCatalogo, RepositorioCatalogo } from '../base/repositorio-catalogo';

const CON_AEROLINEA = { aerolinea: { select: { codigo_iata: true, activo: true } } } as const;

export type FilaFamiliaTarifa = Prisma.familia_tarifaGetPayload<{
  include: typeof CON_AEROLINEA;
}>;

export interface FiltroFamiliaTarifa extends FiltroCatalogo {
  codigoAerolinea?: string;
  claseCabina?: clase_cabina;
}

/** Columnas que se pueden modificar (la clave natural no). */
export interface ReglasFamilia {
  nombre?: string;
  esCambiable?: boolean;
  porcentajePenalidad?: string;
  incluyeArticuloPersonal?: boolean;
  equipajeMano?: number;
  equipajeBodega?: number;
  maximoAdicional?: number;
}

function aColumnas(reglas: ReglasFamilia) {
  return {
    nombre: reglas.nombre,
    es_cambiable: reglas.esCambiable,
    // El texto llega validado; Prisma lo convierte a numeric sin pasar por un number
    porcentaje_penalidad_cancelacion: reglas.porcentajePenalidad,
    incluye_articulo_personal: reglas.incluyeArticuloPersonal,
    equipaje_mano_incluido: reglas.equipajeMano,
    equipaje_bodega_incluido: reglas.equipajeBodega,
    maximo_equipaje_adicional: reglas.maximoAdicional,
  };
}

@Injectable()
export class FamiliaTarifaRepository extends RepositorioCatalogo<
  FilaFamiliaTarifa,
  FiltroFamiliaTarifa
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  claveDe(fila: FilaFamiliaTarifa): string {
    return fila.id_publico;
  }

  async buscar(clave: string, db: Ejecutor = this.prisma.db): Promise<FilaFamiliaTarifa | null> {
    if (!this.esUuid(clave)) return null;
    return db.familia_tarifa.findUnique({ where: { id_publico: clave }, include: CON_AEROLINEA });
  }

  listar(
    filtro: FiltroFamiliaTarifa,
    despuesDe: FilaFamiliaTarifa | null,
    cantidad: number,
  ): Promise<FilaFamiliaTarifa[]> {
    return this.prisma.db.familia_tarifa.findMany({
      where: {
        ...this.soloActivos(filtro),
        ...(filtro.codigoAerolinea ? { aerolinea: { codigo_iata: filtro.codigoAerolinea } } : {}),
        ...(filtro.claseCabina ? { clase_cabina: filtro.claseCabina } : {}),
        ...(despuesDe ? { id: { gt: despuesDe.id } } : {}),
      },
      include: CON_AEROLINEA,
      orderBy: { id: 'asc' },
      take: cantidad,
    });
  }

  estaActiva(fila: FilaFamiliaTarifa): boolean {
    return fila.activo;
  }

  async fijarActivo(fila: FilaFamiliaTarifa, activo: boolean, tx: Ejecutor): Promise<void> {
    await tx.familia_tarifa.update({ where: { id: fila.id }, data: { activo } });
  }

  async insertar(
    datos: ReglasFamilia & {
      aerolineaId: bigint;
      claseCabina: clase_cabina;
      codigo: string;
      nombre: string;
      esCambiable: boolean;
    },
    tx: Ejecutor,
  ): Promise<string> {
    const fila = await tx.familia_tarifa.create({
      data: {
        ...aColumnas(datos),
        nombre: datos.nombre,
        es_cambiable: datos.esCambiable,
        aerolinea_id: datos.aerolineaId,
        clase_cabina: datos.claseCabina,
        codigo: datos.codigo,
      },
      select: { id_publico: true },
    });
    return fila.id_publico;
  }

  async modificar(fila: FilaFamiliaTarifa, reglas: ReglasFamilia, tx: Ejecutor): Promise<void> {
    await tx.familia_tarifa.update({ where: { id: fila.id }, data: aColumnas(reglas) });
  }

  /**
   * Tarifas activas de la familia en salidas que todavía no despegan ni se cancelaron: las
   * que siguen a la venta. Las de salidas pasadas son historia y no la bloquean.
   */
  contarTarifasEnVenta(fila: FilaFamiliaTarifa, tx: Ejecutor): Promise<number> {
    return tx.tarifa_cabecera.count({
      where: {
        familia_tarifa_id: fila.id,
        activo: true,
        vuelo_programado: { estado: { not: 'CANCELADO' }, salida_programada: { gt: new Date() } },
      },
    });
  }
}
