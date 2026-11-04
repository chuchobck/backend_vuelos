import { Injectable } from '@nestjs/common';
import { clase_cabina, Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { DatosStock } from './item-stock';
import { registrarOrdenes } from './ordenes-stock';

export type EstadoOrdenStock = 'PENDIENTE' | 'ENVIADO' | 'FALLIDO';

/** Una orden tomada por el trabajador, con lo que hace falta para armar el registro (el cupo, ACTUAL). */
export interface OrdenReclamada extends DatosStock {
  salidaId: string;
  version: string;
  intentos: number;
  correlationId: string | null;
  /** El arrendamiento con el que se tomó: solo quien lo tiene puede anotar el resultado. */
  arrendamientoHasta: Date;
}

export interface ResultadoOrden {
  estado: EstadoOrdenStock;
  intentos: number;
  codigoHttp: number | null;
  error: string | null;
  proximoIntento: Date | null;
  /** available_units mandado; solo cuando Booking respondió success. */
  unidades: number | null;
}

/** Las columnas que arman un registro, de una salida y su cabina. */
const DATOS = Prisma.sql`
  ac.codigo_iata || v.numero AS "numeroVuelo", ic.clase_cabina::text AS "cabina",
  vp.fecha_salida AS "fechaSalida", vp.salida_programada AS "salidaProgramada",
  c.zona_horaria AS "zonaHoraria",
  (CASE WHEN vp.estado::text = 'CANCELADO' THEN 0 ELSE ic.cupos_disponibles END)::int AS "unidades"`;

/**
 * La cola de empuje de stock (orden_stock_booking) y la lectura del cupo actual. Todo SQL crudo
 * con tablas calificadas; ninguna fila se borra: la tabla queda acotada por inventario_cabina.
 */
@Injectable()
export class StockBookingRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Toma hasta `limite` órdenes PENDIENTE ya vencidas de espera y sin arrendamiento vigente, y lee
   * en la misma sentencia el cupo ACTUAL de cada una (0 si la salida está cancelada). Con
   * FOR UPDATE SKIP LOCKED y un arrendamiento: dos procesos nunca toman la misma clave, y el HTTP
   * ocurre después, fuera de toda transacción. Cada toma suma un intento.
   */
  reclamar(ahora: Date, limite: number, arrendamientoSegundos: number): Promise<OrdenReclamada[]> {
    return this.prisma.db.$queryRaw<OrdenReclamada[]>`
      WITH elegidas AS (
        SELECT o.vuelo_programado_id, o.clase_cabina
          FROM vuelos.orden_stock_booking o
         WHERE o.estado = 'PENDIENTE' AND o.proximo_intento <= ${ahora}::timestamptz
           AND (o.arrendamiento_hasta IS NULL OR o.arrendamiento_hasta <= ${ahora}::timestamptz)
         ORDER BY o.proximo_intento, o.vuelo_programado_id, o.clase_cabina
         LIMIT ${limite}
           FOR UPDATE OF o SKIP LOCKED
      ), tomadas AS (
        UPDATE vuelos.orden_stock_booking o
           SET intentos = o.intentos + 1,
               arrendamiento_hasta = ${ahora}::timestamptz + make_interval(secs => ${arrendamientoSegundos})
          FROM elegidas e
         WHERE o.vuelo_programado_id = e.vuelo_programado_id AND o.clase_cabina = e.clase_cabina
        RETURNING o.vuelo_programado_id, o.clase_cabina, o.version, o.intentos,
                  o.correlation_id, o.arrendamiento_hasta
      )
      SELECT t.vuelo_programado_id::text AS "salidaId", t.version::text AS "version",
             t.intentos::int AS "intentos", t.correlation_id AS "correlationId",
             t.arrendamiento_hasta AS "arrendamientoHasta", ${DATOS}
        FROM tomadas t
        JOIN vuelos.vuelo_programado vp  ON vp.id = t.vuelo_programado_id
        JOIN vuelos.vuelo v              ON v.id = vp.vuelo_id
        JOIN vuelos.aerolinea ac         ON ac.id = v.aerolinea_id
        JOIN vuelos.aeropuerto ao        ON ao.id = v.aeropuerto_origen_id
        JOIN vuelos.ciudad c             ON c.id = ao.ciudad_id
        JOIN vuelos.inventario_cabina ic ON ic.vuelo_programado_id = t.vuelo_programado_id
                                        AND ic.clase_cabina = t.clase_cabina
       ORDER BY t.vuelo_programado_id, t.clase_cabina`;
  }

  /**
   * Anota cómo salió el envío. Solo lo aplica quien sigue teniendo el arrendamiento con el que
   * tomó la orden. Si mientras tanto llegó una orden nueva de la misma clave (otra `version`), no
   * se pisa: la fila sigue PENDIENTE para mandar el valor nuevo, y aquí solo se suelta el
   * arrendamiento. Devuelve 'aplicado', 'superada' o null si ya no era suya.
   */
  async registrarResultado(
    orden: Pick<OrdenReclamada, 'salidaId' | 'version' | 'arrendamientoHasta'> & {
      cabina: clase_cabina;
    },
    ahora: Date,
    r: ResultadoOrden,
  ): Promise<'aplicado' | 'superada' | null> {
    const filas = await this.prisma.db.$queryRaw<Array<{ vigente: boolean }>>`
      UPDATE vuelos.orden_stock_booking o
         SET estado = CASE WHEN o.version = ${orden.version}::bigint
                           THEN ${r.estado}::vuelos.estado_orden_stock ELSE o.estado END,
             intentos = CASE WHEN o.version = ${orden.version}::bigint
                             THEN ${r.intentos}::smallint ELSE o.intentos END,
             proximo_intento = CASE WHEN o.version = ${orden.version}::bigint
                                    THEN COALESCE(${r.proximoIntento}::timestamptz, o.proximo_intento)
                                    ELSE o.proximo_intento END,
             ultimo_codigo_http = CASE WHEN o.version = ${orden.version}::bigint
                                       THEN ${r.codigoHttp}::smallint ELSE o.ultimo_codigo_http END,
             ultimo_error = CASE WHEN o.version = ${orden.version}::bigint
                                 THEN ${r.error}::text ELSE o.ultimo_error END,
             enviado_en = CASE WHEN o.version = ${orden.version}::bigint AND ${r.estado}::text = 'ENVIADO'
                               THEN ${ahora}::timestamptz ELSE o.enviado_en END,
             unidades_enviadas = CASE WHEN o.version = ${orden.version}::bigint AND ${r.estado}::text = 'ENVIADO'
                                      THEN ${r.unidades}::smallint ELSE o.unidades_enviadas END,
             arrendamiento_hasta = NULL
       WHERE o.vuelo_programado_id = ${orden.salidaId}::uuid
         AND o.clase_cabina = ${orden.cabina}::vuelos.clase_cabina
         AND o.arrendamiento_hasta = ${orden.arrendamientoHasta}::timestamptz
      RETURNING (o.version = ${orden.version}::bigint) AS vigente`;
    if (filas.length === 0) return null;
    return filas[0].vigente ? 'aplicado' : 'superada';
  }

  /** Cuántas órdenes están PENDIENTE y desde cuándo espera la más vieja (null si no hay), con plazo en la base. */
  async resumenPendientes(plazoMs: number): Promise<{ pendientes: number; desde: Date | null }> {
    const [, filas] = await this.prisma.db.$transaction([
      this.prisma.db.$executeRaw`SELECT set_config('statement_timeout', ${String(plazoMs)}, true)`,
      this.prisma.db.$queryRaw<Array<{ n: number; desde: Date | null }>>`
        SELECT count(*)::int AS n, min(solicitado_en) AS desde
          FROM vuelos.orden_stock_booking WHERE estado = 'PENDIENTE'`,
    ]);
    return { pendientes: filas[0]?.n ?? 0, desde: filas[0]?.desde ?? null };
  }

  /**
   * Las órdenes de las salidas con fecha local entre `desde` y `hasta`: PENDIENTE ya tomables
   * (`listas`), PENDIENTE esperando un reintento y FALLIDO. Dice si la sincronización terminó.
   */
  async contar(
    ahora: Date,
    desde: Date,
    hasta: Date,
  ): Promise<{ listas: number; enEspera: number; fallidas: number }> {
    const [fila] = await this.prisma.db.$queryRaw<
      Array<{ listas: number; en_espera: number; fallidas: number }>
    >`
      SELECT count(*) FILTER (WHERE o.estado = 'PENDIENTE' AND o.proximo_intento <= ${ahora}::timestamptz)::int AS listas,
             count(*) FILTER (WHERE o.estado = 'PENDIENTE' AND o.proximo_intento > ${ahora}::timestamptz)::int AS en_espera,
             count(*) FILTER (WHERE o.estado = 'FALLIDO')::int AS fallidas
        FROM vuelos.orden_stock_booking o
        JOIN vuelos.vuelo_programado vp ON vp.id = o.vuelo_programado_id
       WHERE vp.fecha_salida BETWEEN ${desde}::date AND ${hasta}::date`;
    return { listas: fila.listas, enEspera: fila.en_espera, fallidas: fila.fallidas };
  }

  /**
   * Registra una orden por cada cabina de las salidas con fecha local entre `desde` y `hasta`
   * (inclusive), un día por sentencia. Devuelve cuántas claves quedaron registradas.
   */
  async registrarVentana(
    desde: Date,
    hasta: Date,
    ahora: Date,
    correlacion: string | null,
  ): Promise<number> {
    let total = 0;
    for (let dia = new Date(desde); dia.getTime() <= hasta.getTime();) {
      total += await registrarOrdenes(
        this.prisma.db,
        Prisma.sql`SELECT ic.vuelo_programado_id AS salida_id, ic.clase_cabina::text AS cabina
                     FROM vuelos.inventario_cabina ic
                     JOIN vuelos.vuelo_programado vp ON vp.id = ic.vuelo_programado_id
                    WHERE vp.fecha_salida = ${dia}::date`,
        ahora,
        correlacion,
      );
      dia = new Date(dia.getTime() + 24 * 60 * 60 * 1000);
    }
    return total;
  }

  /** Lo que mandaría la sincronización completa, sin escribir nada (--dry-run). */
  listarVentana(desde: Date, hasta: Date): Promise<DatosStock[]> {
    return this.prisma.db.$queryRaw<DatosStock[]>`
      SELECT ${DATOS}
        FROM vuelos.inventario_cabina ic
        JOIN vuelos.vuelo_programado vp ON vp.id = ic.vuelo_programado_id
        JOIN vuelos.vuelo v             ON v.id = vp.vuelo_id
        JOIN vuelos.aerolinea ac        ON ac.id = v.aerolinea_id
        JOIN vuelos.aeropuerto ao       ON ao.id = v.aeropuerto_origen_id
        JOIN vuelos.ciudad c            ON c.id = ao.ciudad_id
       WHERE vp.fecha_salida BETWEEN ${desde}::date AND ${hasta}::date
       ORDER BY vp.fecha_salida, vp.salida_programada, ac.codigo_iata, v.numero, ic.clase_cabina`;
  }
}
