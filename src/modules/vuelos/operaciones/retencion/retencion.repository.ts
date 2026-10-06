import { Injectable } from '@nestjs/common';
import {
  clase_cabina,
  estado_retencion,
  estado_vuelo,
  Prisma,
  tipo_pasajero,
} from '../../../../generated/prisma/client';
import { PrismaService, TransaccionVuelos } from '../../../../prisma/prisma.service';
import { ActorAuditoria } from '../../../../prisma/extensiones/transaccion-auditada';
import { ClaveNueva, IdempotenciaRepository } from '../../compartido/idempotencia.repository';
import { PublicadorEventos } from '../webhook/publicador-eventos';
import { Retencion } from './retencion.modelo';

/** Estados en los que una salida se vende (los mismos de la búsqueda y del mapa de asientos). */
const ESTADOS_VENDIBLES: estado_vuelo[] = ['PROGRAMADO', 'DEMORADO'];

/**
 * Vencer una retención es un proceso del sistema, no de quien hizo la petición que lo
 * disparó: la auditoría lo registra sin usuario (auditoria.id_usuario NULL, como dice su
 * COMMENT para los procesos internos).
 */
export const ACTOR_SISTEMA: ActorAuditoria = { idUsuario: null, direccionIp: null };

/** Una oferta guardada por la búsqueda, con sus itinerarios y las salidas de cada uno, en orden. */
export interface OfertaParaRetener {
  aerolineaId: bigint;
  vence: Date;
  itinerarios: Array<{ id: string; salidas: string[] }>;
}

export interface FamiliaDeOferta {
  id: bigint;
  cabina: clase_cabina;
  codigo: string;
  activo: boolean;
}

/** Precio vigente de una familia en una salida vendible, para un tipo de pasajero. */
export interface FilaPrecioActual {
  salida_id: string;
  familia_id: bigint;
  tipo_pasajero: tipo_pasajero;
  tarifa_base: Prisma.Decimal;
  impuestos: Prisma.Decimal;
  moneda_id: bigint;
  moneda: string;
}

/** Cupos que una retención toma (o devuelve) de una cabina de una salida. */
export interface CupoDeCabina {
  salidaId: string;
  cabina: clase_cabina;
  cantidad: number;
}

export interface RetencionNueva {
  id: string;
  ofertaId: string;
  idPropietario: string;
  monedaId: bigint;
  adultos: number;
  jovenes: number;
  ninos: number;
  infantes: number;
  creada: Date;
  vence: Date;
  lineas: Array<{
    itinerarioId: string;
    familiaId: bigint;
    base: Prisma.Decimal;
    impuestos: Prisma.Decimal;
  }>;
  cupos: CupoDeCabina[];
}

/** Por qué no se creó la retención (la transacción se deshizo entera). */
export type RechazoCreacion = 'clave-en-uso' | 'oferta-vencida' | 'sin-cupo';

/** Cómo se cierra una retención que sigue RETENIDA. */
export type Cierre = 'liberar' | 'vencer' | 'consumir';

class Rechazo extends Error {
  constructor(readonly motivo: RechazoCreacion) {
    super(motivo);
  }
}

interface FilaRetencion {
  id: string;
  id_propietario: string;
  estado: estado_retencion;
  fecha_creacion: Date;
  fecha_expiracion: Date;
  moneda: string;
  tarifa_base: Prisma.Decimal;
  impuestos: Prisma.Decimal;
  total: Prisma.Decimal;
}

/**
 * Retenciones (hold), su cupo y las claves de idempotencia de POST /offers/hold.
 *
 * El cupo se mueve siempre con una sola sentencia por retención que primero bloquea las filas
 * de inventario_cabina en un orden fijo (salida y cabina) y después las actualiza con la
 * condición de que alcance. Dos retenciones que compiten por las mismas cabinas se esperan
 * en vez de cruzarse (sin deadlock), y ninguna puede dejar el cupo negativo: si a una fila no
 * le alcanza, la sentencia cambia menos filas de las pedidas y la transacción se deshace.
 * Todo cambio va dentro de transaccionAuditada.
 *
 * Los instantes (`ahora`) los pone el service con su reloj: la base no usa now() para decidir
 * si algo venció.
 */
@Injectable()
export class RetencionRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly claves: IdempotenciaRepository,
    private readonly publicador: PublicadorEventos,
  ) {}

  async oferta(ofertaId: string): Promise<OfertaParaRetener | null> {
    const fila = await this.prisma.db.oferta_cabecera.findUnique({
      where: { id: ofertaId },
      select: {
        aerolinea_id: true,
        fecha_expiracion: true,
        oferta_detalle: {
          orderBy: { orden: 'asc' },
          select: {
            itinerario_id: true,
            itinerario_cabecera: {
              select: {
                itinerario_detalle: {
                  orderBy: { orden: 'asc' },
                  select: { vuelo_programado_id: true },
                },
              },
            },
          },
        },
      },
    });
    if (!fila) return null;
    return {
      aerolineaId: fila.aerolinea_id,
      vence: fila.fecha_expiracion,
      itinerarios: fila.oferta_detalle.map((d) => ({
        id: d.itinerario_id,
        salidas: d.itinerario_cabecera.itinerario_detalle.map((s) => s.vuelo_programado_id),
      })),
    };
  }

  /** Las familias de la aerolínea con esa cabina y ese código (activas o no). */
  familias(
    aerolineaId: bigint,
    pedidas: ReadonlyArray<{ cabina: clase_cabina; codigo: string }>,
  ): Promise<FamiliaDeOferta[]> {
    return this.prisma.db.familia_tarifa
      .findMany({
        where: {
          aerolinea_id: aerolineaId,
          OR: pedidas.map((p) => ({ clase_cabina: p.cabina, codigo: p.codigo })),
        },
        select: { id: true, clase_cabina: true, codigo: true, activo: true },
      })
      .then((filas) =>
        filas.map((f) => ({
          id: f.id,
          cabina: f.clase_cabina,
          codigo: f.codigo,
          activo: f.activo,
        })),
      );
  }

  /**
   * Precios de hoy de esas familias en esas salidas, con las mismas condiciones de venta de la
   * búsqueda: vuelo, aerolíneas y aeropuertos activos, salida PROGRAMADO o DEMORADO y todavía
   * futura, tarifa y moneda activas. Lo que no se vende ya no aparece.
   */
  preciosActuales(
    salidas: readonly string[],
    familias: readonly bigint[],
    tipos: readonly tipo_pasajero[],
    ahora: Date,
  ): Promise<FilaPrecioActual[]> {
    return this.prisma.db.$queryRaw<FilaPrecioActual[]>`
      SELECT t.vuelo_programado_id AS salida_id, t.familia_tarifa_id AS familia_id,
             td.tipo_pasajero::text AS tipo_pasajero, td.tarifa_base, td.impuestos,
             mo.id AS moneda_id, mo.codigo_iso AS moneda
        FROM vuelos.tarifa_cabecera t
        JOIN vuelos.tarifa_detalle td    ON td.tarifa_id = t.id
        JOIN vuelos.moneda mo            ON mo.id = t.moneda_id
        JOIN vuelos.vuelo_programado vp  ON vp.id = t.vuelo_programado_id
        JOIN vuelos.vuelo v              ON v.id = vp.vuelo_id
        JOIN vuelos.aerolinea ac         ON ac.id = v.aerolinea_id
        JOIN vuelos.aerolinea ao         ON ao.id = v.aerolinea_operadora_id
        JOIN vuelos.aeropuerto po        ON po.id = v.aeropuerto_origen_id
        JOIN vuelos.aeropuerto pd        ON pd.id = v.aeropuerto_destino_id
       WHERE t.vuelo_programado_id = ANY(${salidas}::uuid[])
         AND t.familia_tarifa_id = ANY(${familias}::bigint[])
         AND td.tipo_pasajero::text = ANY(${tipos})
         AND t.activo AND mo.activo
         AND v.activo AND ac.activo AND ao.activo AND po.activo AND pd.activo
         AND vp.estado::text = ANY(${ESTADOS_VENDIBLES})
         AND vp.salida_programada > ${ahora}::timestamptz`;
  }

  /**
   * Crea la retención en una transacción, todo o nada:
   *
   * 1. Reclama la clave de idempotencia (con la respuesta ya armada). Si otra petición con la
   *    misma clave está en curso, el INSERT espera a que termine: si ella confirma, este no
   *    inserta nada y se devuelve 'clave-en-uso' para repetir su respuesta; si ella se deshace,
   *    este sigue. Así dos peticiones simultáneas con la misma clave no crean dos retenciones.
   * 2. Comprueba que la oferta siga vigente y la bloquea contra la purga de ofertas vencidas.
   * 3. Toma los cupos (ver la clase). Si a una cabina no le alcanza: 'sin-cupo'.
   * 4. Inserta la cabecera y las líneas con el precio congelado.
   *
   * Devuelve null si la creó, o el motivo por el que no (y no cambió nada).
   */
  async crear(retencion: RetencionNueva, clave: ClaveNueva): Promise<RechazoCreacion | null> {
    try {
      await this.prisma.transaccionAuditada(async (tx) => {
        if (!(await this.claves.reclamar(tx, clave))) throw new Rechazo('clave-en-uso');

        const vigente = await tx.$queryRaw<unknown[]>`
          SELECT 1 FROM vuelos.oferta_cabecera
           WHERE id = ${retencion.ofertaId}::uuid AND fecha_expiracion > ${retencion.creada}::timestamptz
             FOR KEY SHARE`;
        if (vigente.length === 0) throw new Rechazo('oferta-vencida');

        if ((await tomarCupos(tx, retencion.cupos)) !== retencion.cupos.length) {
          throw new Rechazo('sin-cupo');
        }

        await tx.retencion_cabecera.create({
          data: {
            id: retencion.id,
            oferta_id: retencion.ofertaId,
            id_propietario: retencion.idPropietario,
            moneda_id: retencion.monedaId,
            adultos: retencion.adultos,
            jovenes: retencion.jovenes,
            ninos: retencion.ninos,
            infantes: retencion.infantes,
            fecha_creacion: retencion.creada,
            fecha_expiracion: retencion.vence,
          },
        });
        await tx.retencion_detalle.createMany({
          data: retencion.lineas.map((linea) => ({
            retencion_id: retencion.id,
            itinerario_id: linea.itinerarioId,
            familia_tarifa_id: linea.familiaId,
            tarifa_base_congelada: linea.base,
            impuestos_congelados: linea.impuestos,
          })),
        });
      });
      return null;
    } catch (error) {
      if (error instanceof Rechazo) return error.motivo;
      throw error;
    }
  }

  /** La retención con su lockedPrice (vista_retencion_precio), o null si no existe. */
  async leer(id: string): Promise<Retencion | null> {
    const [fila] = await this.prisma.db.$queryRaw<FilaRetencion[]>`
      SELECT r.id, r.id_propietario, r.estado::text AS estado, r.fecha_creacion,
             r.fecha_expiracion, p.moneda, p.tarifa_base, p.impuestos, p.total
        FROM vuelos.retencion_cabecera r
        JOIN vuelos.vista_retencion_precio p ON p.retencion_id = r.id
       WHERE r.id = ${id}::uuid`;
    if (!fila) return null;
    return {
      id: fila.id,
      idPropietario: fila.id_propietario,
      estado: fila.estado,
      creada: fila.fecha_creacion,
      vence: fila.fecha_expiracion,
      precio: {
        moneda: fila.moneda,
        base: fila.tarifa_base,
        impuestos: fila.impuestos,
        total: fila.total,
      },
    };
  }

  /**
   * Cierra una retención que sigue RETENIDA y, salvo al consumirla, devuelve sus cupos:
   *
   * - 'liberar': LIBERADA; si ya pasó su vencimiento, EXPIRADA (el cupo vuelve igual).
   * - 'vencer': EXPIRADA, solo si ya pasó su vencimiento.
   * - 'consumir': CONSUMIDA, solo si todavía no venció. El cupo pasa a la reserva.
   *
   * El UPDATE de la cabecera es condicionado (estado = 'RETENIDA'): si dos procesos la cierran
   * a la vez, uno la cambia y el otro no toca nada, así el cupo nunca vuelve dos veces.
   * Devuelve el estado nuevo, o null si no la cerró (no existe, ya estaba cerrada o la
   * condición de tiempo no se cumplió).
   *
   * `tx` permite cerrarla dentro de una transacción ajena (la reserva de la fase 7 consume la
   * retención en la misma transacción que crea la reserva).
   */
  async cerrar(
    id: string,
    cierre: Cierre,
    ahora: Date,
    opciones: { actor?: ActorAuditoria; tx?: TransaccionVuelos } = {},
  ): Promise<estado_retencion | null> {
    const trabajo = async (tx: TransaccionVuelos) => {
      const [fila] = await tx.$queryRaw<Array<{ estado: estado_retencion }>>`
        UPDATE vuelos.retencion_cabecera
           SET estado = (CASE
                 WHEN ${cierre}::text = 'consumir' THEN 'CONSUMIDA'
                 WHEN fecha_expiracion <= ${ahora}::timestamptz THEN 'EXPIRADA'
                 ELSE 'LIBERADA' END)::vuelos.estado_retencion,
               fecha_cierre = ${ahora}::timestamptz
         WHERE id = ${id}::uuid
           AND estado = 'RETENIDA'
           AND (${cierre}::text = 'liberar'
                OR (${cierre}::text = 'vencer' AND fecha_expiracion <= ${ahora}::timestamptz)
                OR (${cierre}::text = 'consumir' AND fecha_expiracion > ${ahora}::timestamptz))
        RETURNING estado::text AS estado`;
      if (!fila) return null;
      if (cierre !== 'consumir') await devolverCupos(tx, id);
      if (fila.estado === 'EXPIRADA') await this.publicador.deRetencionVencida(tx, id, ahora);
      return fila.estado;
    };
    if (opciones.tx) return trabajo(opciones.tx);
    return this.prisma.transaccionAuditada(trabajo, { actor: opciones.actor });
  }

  /**
   * Vence la retención vencida más antigua (de esas salidas, si se dan) y devuelve su cupo, en
   * una transacción propia. `SKIP LOCKED` hace que dos procesos que vencen a la vez tomen
   * retenciones distintas en vez de esperarse. Devuelve su id, o null si no quedaba ninguna.
   */
  vencerSiguiente(ahora: Date, salidas?: readonly string[]): Promise<string | null> {
    return this.prisma.transaccionAuditada(
      async (tx) => {
        const [fila] = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT r.id
            FROM vuelos.retencion_cabecera r
           WHERE r.estado = 'RETENIDA'
             AND r.fecha_expiracion <= ${ahora}::timestamptz
             AND (${salidas === undefined}
                  OR EXISTS (SELECT 1
                               FROM vuelos.retencion_detalle d
                               JOIN vuelos.itinerario_detalle i ON i.itinerario_id = d.itinerario_id
                              WHERE d.retencion_id = r.id
                                AND i.vuelo_programado_id = ANY(${salidas ?? []}::uuid[])))
           ORDER BY r.fecha_expiracion, r.id
           LIMIT 1
             FOR UPDATE OF r SKIP LOCKED`;
        if (!fila) return null;
        await tx.$executeRaw`
          UPDATE vuelos.retencion_cabecera
             SET estado = 'EXPIRADA', fecha_cierre = ${ahora}::timestamptz
           WHERE id = ${fila.id}::uuid`;
        await devolverCupos(tx, fila.id);
        await this.publicador.deRetencionVencida(tx, fila.id, ahora);
        return fila.id;
      },
      { actor: ACTOR_SISTEMA },
    );
  }
}

/** Arreglos paralelos para unnest(): salida, cabina y cantidad de cada fila pedida. */
function columnas(cupos: readonly CupoDeCabina[]) {
  return {
    salidas: cupos.map((c) => c.salidaId),
    cabinas: cupos.map((c) => c.cabina),
    cantidades: cupos.map((c) => c.cantidad),
  };
}

/**
 * Descuenta los cupos en una sola sentencia: bloquea las filas en orden (salida, cabina) y
 * resta solo donde alcanza. Devuelve cuántas filas cambió; si es menos que `cupos.length`, a
 * alguna no le alcanzó y quien llama debe deshacer la transacción.
 */
async function tomarCupos(tx: TransaccionVuelos, cupos: readonly CupoDeCabina[]): Promise<number> {
  const { salidas, cabinas, cantidades } = columnas(cupos);
  return tx.$executeRaw`
    WITH pedido AS (
      SELECT * FROM unnest(${salidas}::uuid[], ${cabinas}::text[], ${cantidades}::int[])
                 AS p(salida_id, clase_cabina, cantidad)
    ), bloqueadas AS MATERIALIZED (
      SELECT ic.id, p.cantidad
        FROM vuelos.inventario_cabina ic
        JOIN pedido p ON p.salida_id = ic.vuelo_programado_id
                     AND p.clase_cabina = ic.clase_cabina::text
       ORDER BY ic.vuelo_programado_id, ic.clase_cabina
         FOR UPDATE OF ic
    )
    UPDATE vuelos.inventario_cabina ic
       SET cupos_disponibles = ic.cupos_disponibles - b.cantidad
      FROM bloqueadas b
     WHERE ic.id = b.id
       AND ic.cupos_disponibles >= b.cantidad`;
}

/**
 * Devuelve el cupo de una retención, calculado desde la base (sus itinerarios, la cabina de
 * cada familia y los pasajeros con asiento), con el mismo orden de bloqueo que tomarCupos.
 * LEAST protege ck_inventario_cabina_cupos_disponibles: el catálogo nunca deja el total por
 * debajo de lo comprometido, así que en la práctica no recorta nada.
 */
async function devolverCupos(tx: TransaccionVuelos, retencionId: string): Promise<void> {
  await tx.$executeRaw`
    WITH pedido AS (
      SELECT i.vuelo_programado_id AS salida_id, f.clase_cabina,
             SUM(r.adultos + r.jovenes + r.ninos)::int AS cantidad
        FROM vuelos.retencion_cabecera r
        JOIN vuelos.retencion_detalle d   ON d.retencion_id = r.id
        JOIN vuelos.itinerario_detalle i  ON i.itinerario_id = d.itinerario_id
        JOIN vuelos.familia_tarifa f      ON f.id = d.familia_tarifa_id
       WHERE r.id = ${retencionId}::uuid
       GROUP BY i.vuelo_programado_id, f.clase_cabina
    ), bloqueadas AS MATERIALIZED (
      SELECT ic.id, p.cantidad
        FROM vuelos.inventario_cabina ic
        JOIN pedido p ON p.salida_id = ic.vuelo_programado_id
                     AND p.clase_cabina = ic.clase_cabina
       ORDER BY ic.vuelo_programado_id, ic.clase_cabina
         FOR UPDATE OF ic
    )
    UPDATE vuelos.inventario_cabina ic
       SET cupos_disponibles = LEAST(ic.cupos_totales, ic.cupos_disponibles + b.cantidad)
      FROM bloqueadas b
     WHERE ic.id = b.id`;
}
