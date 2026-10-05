import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { Ejecutor, FiltroCatalogo, RepositorioCatalogo } from '../base/repositorio-catalogo';

const AEROLINEA = { select: { id: true, codigo_iata: true, activo: true } } as const;
const AEROPUERTO = {
  select: {
    codigo_iata: true,
    activo: true,
    ciudad: { select: { zona_horaria: true } },
  },
} as const;
const CON_RUTA = {
  aerolinea_vuelo_aerolinea_idToaerolinea: AEROLINEA,
  aerolinea_vuelo_aerolinea_operadora_idToaerolinea: AEROLINEA,
  aeropuerto_vuelo_aeropuerto_origen_idToaeropuerto: AEROPUERTO,
  aeropuerto_vuelo_aeropuerto_destino_idToaeropuerto: AEROPUERTO,
} as const;

type FilaPrisma = Prisma.vueloGetPayload<{ include: typeof CON_RUTA }>;

/** El vuelo con nombres legibles en lugar de los que genera db pull para las FK dobles. */
export interface FilaVuelo {
  id: bigint;
  numero: string;
  activo: boolean;
  comercializa: FilaPrisma['aerolinea_vuelo_aerolinea_idToaerolinea'];
  opera: FilaPrisma['aerolinea_vuelo_aerolinea_operadora_idToaerolinea'];
  origen: FilaPrisma['aeropuerto_vuelo_aeropuerto_origen_idToaeropuerto'];
  destino: FilaPrisma['aeropuerto_vuelo_aeropuerto_destino_idToaeropuerto'];
}

function aFila(fila: FilaPrisma): FilaVuelo {
  return {
    id: fila.id,
    numero: fila.numero,
    activo: fila.activo,
    comercializa: fila.aerolinea_vuelo_aerolinea_idToaerolinea,
    opera: fila.aerolinea_vuelo_aerolinea_operadora_idToaerolinea,
    origen: fila.aeropuerto_vuelo_aeropuerto_origen_idToaeropuerto,
    destino: fila.aeropuerto_vuelo_aeropuerto_destino_idToaeropuerto,
  };
}

/** AV1234 → aerolínea AV y número 1234. El formato ya lo validó el pipe o el DTO. */
export function partirNumeroVuelo(numeroVuelo: string): { aerolinea: string; numero: string } {
  return { aerolinea: numeroVuelo.slice(0, 2), numero: numeroVuelo.slice(2) };
}

export function numeroVueloDe(fila: FilaVuelo): string {
  return `${fila.comercializa.codigo_iata}${fila.numero}`;
}

export interface FiltroVuelo extends FiltroCatalogo {
  codigoAerolinea?: string;
  codigoOrigen?: string;
  codigoDestino?: string;
}

@Injectable()
export class VueloRepository extends RepositorioCatalogo<FilaVuelo, FiltroVuelo> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  claveDe(fila: FilaVuelo): string {
    return numeroVueloDe(fila);
  }

  async buscar(clave: string, db: Ejecutor = this.prisma.db): Promise<FilaVuelo | null> {
    const { aerolinea, numero } = partirNumeroVuelo(clave);
    const fila = await db.vuelo.findFirst({
      where: { numero, aerolinea_vuelo_aerolinea_idToaerolinea: { codigo_iata: aerolinea } },
      include: CON_RUTA,
    });
    return fila ? aFila(fila) : null;
  }

  async listar(
    filtro: FiltroVuelo,
    despuesDe: FilaVuelo | null,
    cantidad: number,
  ): Promise<FilaVuelo[]> {
    const filas = await this.prisma.db.vuelo.findMany({
      where: {
        ...this.soloActivos(filtro),
        ...(filtro.codigoAerolinea
          ? { aerolinea_vuelo_aerolinea_idToaerolinea: { codigo_iata: filtro.codigoAerolinea } }
          : {}),
        ...(filtro.codigoOrigen
          ? {
              aeropuerto_vuelo_aeropuerto_origen_idToaeropuerto: {
                codigo_iata: filtro.codigoOrigen,
              },
            }
          : {}),
        ...(filtro.codigoDestino
          ? {
              aeropuerto_vuelo_aeropuerto_destino_idToaeropuerto: {
                codigo_iata: filtro.codigoDestino,
              },
            }
          : {}),
        ...(despuesDe ? { id: { gt: despuesDe.id } } : {}),
      },
      include: CON_RUTA,
      orderBy: { id: 'asc' },
      take: cantidad,
    });
    return filas.map(aFila);
  }

  estaActiva(fila: FilaVuelo): boolean {
    return fila.activo;
  }

  async fijarActivo(fila: FilaVuelo, activo: boolean, tx: Ejecutor): Promise<void> {
    await tx.vuelo.update({ where: { id: fila.id }, data: { activo } });
  }

  async insertar(
    datos: {
      aerolineaId: bigint;
      operadoraId: bigint;
      numero: string;
      origenId: bigint;
      destinoId: bigint;
    },
    tx: Ejecutor,
  ): Promise<void> {
    await tx.vuelo.create({
      data: {
        aerolinea_id: datos.aerolineaId,
        aerolinea_operadora_id: datos.operadoraId,
        numero: datos.numero,
        aeropuerto_origen_id: datos.origenId,
        aeropuerto_destino_id: datos.destinoId,
      },
    });
  }

  async modificar(fila: FilaVuelo, datos: { operadoraId?: bigint }, tx: Ejecutor): Promise<void> {
    await tx.vuelo.update({
      where: { id: fila.id },
      data: { aerolinea_operadora_id: datos.operadoraId },
    });
  }

  /** Salidas del vuelo que todavía no despegan ni se cancelaron. */
  contarSalidasProximas(fila: FilaVuelo, tx: Ejecutor): Promise<number> {
    return tx.vuelo_programado.count({
      where: {
        vuelo_id: fila.id,
        estado: { not: 'CANCELADO' },
        salida_programada: { gt: new Date() },
      },
    });
  }
}
