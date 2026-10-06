import { Injectable } from '@nestjs/common';
import { moneda, Prisma, tipo_pasajero } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { Ejecutor, FiltroCatalogo, RepositorioCatalogo } from '../base/repositorio-catalogo';

const CON_DETALLE = {
  vuelo_programado: {
    select: {
      id: true,
      estado: true,
      salida_programada: true,
      vuelo: {
        select: {
          numero: true,
          aerolinea_vuelo_aerolinea_idToaerolinea: { select: { codigo_iata: true } },
        },
      },
    },
  },
  familia_tarifa: {
    select: { id_publico: true, codigo: true, clase_cabina: true, activo: true },
  },
  moneda: { select: { codigo_iso: true } },
  tarifa_detalle: { orderBy: { tipo_pasajero: 'asc' } },
} as const;

export type FilaTarifa = Prisma.tarifa_cabeceraGetPayload<{ include: typeof CON_DETALLE }>;

export interface FiltroTarifa extends FiltroCatalogo {
  salidaId?: string;
  familiaId?: string;
}

/** Montos como texto validado: Prisma los pasa a numeric sin un number de por medio. */
export interface PrecioNuevo {
  tipoPasajero: tipo_pasajero;
  tarifaBase: string;
  impuestos: string;
}

@Injectable()
export class TarifaRepository extends RepositorioCatalogo<FilaTarifa, FiltroTarifa> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  claveDe(fila: FilaTarifa): string {
    return fila.id_publico;
  }

  async buscar(clave: string, db: Ejecutor = this.prisma.db): Promise<FilaTarifa | null> {
    if (!this.esUuid(clave)) return null;
    return db.tarifa_cabecera.findUnique({ where: { id_publico: clave }, include: CON_DETALLE });
  }

  listar(
    filtro: FiltroTarifa,
    despuesDe: FilaTarifa | null,
    cantidad: number,
  ): Promise<FilaTarifa[]> {
    return this.prisma.db.tarifa_cabecera.findMany({
      where: {
        ...this.soloActivos(filtro),
        ...(filtro.salidaId ? { vuelo_programado_id: filtro.salidaId } : {}),
        ...(filtro.familiaId ? { familia_tarifa: { id_publico: filtro.familiaId } } : {}),
        ...(despuesDe ? { id: { gt: despuesDe.id } } : {}),
      },
      include: CON_DETALLE,
      orderBy: { id: 'asc' },
      take: cantidad,
    });
  }

  estaActiva(fila: FilaTarifa): boolean {
    return fila.activo;
  }

  async fijarActivo(fila: FilaTarifa, activo: boolean, tx: Ejecutor): Promise<void> {
    await tx.tarifa_cabecera.update({ where: { id: fila.id }, data: { activo } });
  }

  buscarMoneda(codigoIso: string, tx: Ejecutor): Promise<moneda | null> {
    return tx.moneda.findUnique({ where: { codigo_iso: codigoIso } });
  }

  /** Cabecera y precios por tipo de pasajero en la misma transacción. Devuelve el id público. */
  async insertar(
    datos: {
      salidaId: string;
      familiaId: bigint;
      monedaId: bigint;
      precioEquipaje: string;
      cargoCambio?: string;
      precios: PrecioNuevo[];
    },
    tx: Ejecutor,
  ): Promise<string> {
    const fila = await tx.tarifa_cabecera.create({
      data: {
        vuelo_programado_id: datos.salidaId,
        familia_tarifa_id: datos.familiaId,
        moneda_id: datos.monedaId,
        precio_equipaje_adicional: datos.precioEquipaje,
        cargo_cambio: datos.cargoCambio,
        tarifa_detalle: {
          create: datos.precios.map((p) => ({
            tipo_pasajero: p.tipoPasajero,
            tarifa_base: p.tarifaBase,
            impuestos: p.impuestos,
          })),
        },
      },
      select: { id_publico: true },
    });
    return fila.id_publico;
  }

  /** Montos de la cabecera y, por tipo de pasajero, actualiza o agrega el precio (nunca borra). */
  async modificar(
    fila: FilaTarifa,
    datos: { precioEquipaje?: string; cargoCambio?: string; precios?: PrecioNuevo[] },
    tx: Ejecutor,
  ): Promise<void> {
    await tx.tarifa_cabecera.update({
      where: { id: fila.id },
      data: { precio_equipaje_adicional: datos.precioEquipaje, cargo_cambio: datos.cargoCambio },
    });
    for (const precio of datos.precios ?? []) {
      await tx.tarifa_detalle.upsert({
        where: {
          tarifa_id_tipo_pasajero: { tarifa_id: fila.id, tipo_pasajero: precio.tipoPasajero },
        },
        update: { tarifa_base: precio.tarifaBase, impuestos: precio.impuestos },
        create: {
          tarifa_id: fila.id,
          tipo_pasajero: precio.tipoPasajero,
          tarifa_base: precio.tarifaBase,
          impuestos: precio.impuestos,
        },
      });
    }
  }
}
