import { Injectable } from '@nestjs/common';
import { PrismaService, TransaccionVuelos } from '../../../../prisma/prisma.service';

/** schemaVersion del sobre: el menor de la v1 de los esquemas del notifier (contracts/notifier-eventos). */
export const VERSION_ESQUEMA_EVENTOS = '1.0';

/**
 * De qué proceso de negocio sale un evento: el X-Correlation-Id de la petición que produjo el
 * hecho (null en un proceso periódico) y si además va dentro del sobre (`correlationId`,
 * EVENT_ENVELOPE_CORRELATION_ID=true). Siempre se guarda en la columna correlation_id.
 */
export interface OrigenEvento {
  correlationId: string | null;
  enSobre: boolean;
}

/** Lo que se agrega al sobre: `{"correlationId": ...}` solo si va en el sobre y hay uno. */
function extraDelSobre(origen: OrigenEvento): string {
  return JSON.stringify(
    origen.enSobre && origen.correlationId !== null ? { correlationId: origen.correlationId } : {},
  );
}

/** Cuánto se reintenta publicar un evento antes de dejarlo FALLIDO. */
export const PLAZO_REINTENTOS_HORAS = 48;

/**
 * La bandeja de salida hacia el notifier (evento_saliente, WEBHOOKS_MODE=notifier): UNA fila por
 * hecho, dentro de la transacción del hecho. Si la transacción se deshace, no queda evento.
 *
 * El sobre de POST /internal/v1/events se arma aquí, en el mismo INSERT ... SELECT, con los mismos
 * datos que EntregaRepository usa para el WebhookPayload (PNR, ids públicos, estado y, al
 * cancelar, el reembolso; nada del pasajero), y se guarda como texto: queda congelado y el relevo
 * lo envía byte a byte. A diferencia de webhook_entrega, se guarda aunque el dueño no tenga
 * suscripciones: quién lo recibe lo decide el notifier.
 */
@Injectable()
export class BandejaEventosRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Un evento booking.*; `estados` traduce el estado de la base al del contrato. */
  guardarDeReserva(
    tx: TransaccionVuelos,
    reservaId: string,
    tipo: string,
    ahora: Date,
    eventId: string,
    estados: Record<string, string>,
    traceparent: string | null,
    origen: OrigenEvento,
  ): Promise<number> {
    return tx.$executeRaw`
      INSERT INTO vuelos.evento_saliente
             (id_evento, tipo, id_propietario, sobre, proximo_intento, reintentar_hasta, creado_en,
              traceparent, correlation_id)
      SELECT ${eventId}::uuid, ${tipo}::text, r.id_propietario,
             (jsonb_build_object(
               'eventId', ${eventId}::text, 'eventType', ${tipo}::text,
               'schemaVersion', ${VERSION_ESQUEMA_EVENTOS}::text,
               'occurredAt', to_char(${ahora}::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'ownerId', r.id_propietario,
               'data', jsonb_strip_nulls(jsonb_build_object(
                 'bookingId', rc.id::text, 'pnr', rc.pnr,
                 'status', ${JSON.stringify(estados)}::jsonb ->> rc.estado::text,
                 'refundAmount', (SELECT to_char(c.monto_reembolso, 'FM999999990.00')
                                    FROM vuelos.cotizacion_cancelacion c
                                   WHERE c.reserva_id = rc.id AND c.fecha_aceptacion IS NOT NULL
                                     AND ${tipo}::text = 'booking.cancelled'))))
               || ${extraDelSobre(origen)}::jsonb)::text,
             ${ahora}::timestamptz,
             ${ahora}::timestamptz + make_interval(hours => ${PLAZO_REINTENTOS_HORAS}),
             ${ahora}::timestamptz,
             ${traceparent}::text,
             ${origen.correlationId}::text
        FROM vuelos.reserva_cabecera rc
        JOIN vuelos.retencion_cabecera r ON r.id = rc.retencion_id
       WHERE rc.id = ${reservaId}::uuid`;
  }

  /** hold.expired, del dueño del hold. */
  guardarDeRetencion(
    tx: TransaccionVuelos,
    retencionId: string,
    ahora: Date,
    eventId: string,
    traceparent: string | null,
    origen: OrigenEvento,
  ): Promise<number> {
    return tx.$executeRaw`
      INSERT INTO vuelos.evento_saliente
             (id_evento, tipo, id_propietario, sobre, proximo_intento, reintentar_hasta, creado_en,
              traceparent, correlation_id)
      SELECT ${eventId}::uuid, 'hold.expired', r.id_propietario,
             (jsonb_build_object(
               'eventId', ${eventId}::text, 'eventType', 'hold.expired',
               'schemaVersion', ${VERSION_ESQUEMA_EVENTOS}::text,
               'occurredAt', to_char(${ahora}::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'ownerId', r.id_propietario,
               'data', jsonb_build_object('holdId', r.id::text, 'status', 'EXPIRED'))
               || ${extraDelSobre(origen)}::jsonb)::text,
             ${ahora}::timestamptz,
             ${ahora}::timestamptz + make_interval(hours => ${PLAZO_REINTENTOS_HORAS}),
             ${ahora}::timestamptz,
             ${traceparent}::text,
             ${origen.correlationId}::text
        FROM vuelos.retencion_cabecera r
       WHERE r.id = ${retencionId}::uuid`;
  }

  /**
   * flight.schedule_changed o flight.cancelled: un evento por cada reserva viva (ni cancelada ni
   * fallida) que vuela en esa salida, cada uno con su propio eventId y para el dueño de esa reserva.
   */
  guardarDeVuelo(
    tx: TransaccionVuelos,
    salidaId: string,
    tipo: string,
    ahora: Date,
    estados: Record<string, string>,
    traceparent: string | null,
    origen: OrigenEvento,
  ): Promise<number> {
    return tx.$executeRaw`
      WITH afectadas AS (
        SELECT gen_random_uuid() AS evento, rc.id, rc.pnr, rc.estado, r.id_propietario,
               ac.codigo_iata || v.numero AS vuelo
          FROM vuelos.reserva_cabecera rc
          JOIN vuelos.retencion_cabecera r ON r.id = rc.retencion_id
          JOIN vuelos.vuelo_programado vp  ON vp.id = ${salidaId}::uuid
          JOIN vuelos.vuelo v              ON v.id = vp.vuelo_id
          JOIN vuelos.aerolinea ac         ON ac.id = v.aerolinea_id
         WHERE rc.estado NOT IN ('CANCELADA', 'FALLIDA')
           AND EXISTS (SELECT 1
                         FROM vuelos.reserva_detalle_itinerario ri
                         JOIN vuelos.itinerario_detalle i ON i.itinerario_id = ri.itinerario_id
                        WHERE ri.reserva_id = rc.id AND ri.vigente
                          AND i.vuelo_programado_id = vp.id)
      )
      INSERT INTO vuelos.evento_saliente
             (id_evento, tipo, id_propietario, sobre, proximo_intento, reintentar_hasta, creado_en,
              traceparent, correlation_id)
      SELECT a.evento, ${tipo}::text, a.id_propietario,
             (jsonb_build_object(
               'eventId', a.evento::text, 'eventType', ${tipo}::text,
               'schemaVersion', ${VERSION_ESQUEMA_EVENTOS}::text,
               'occurredAt', to_char(${ahora}::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'ownerId', a.id_propietario,
               'data', jsonb_build_object(
                 'bookingId', a.id::text, 'pnr', a.pnr,
                 'status', ${JSON.stringify(estados)}::jsonb ->> a.estado::text,
                 'flightNumber', a.vuelo, 'segmentId', ${salidaId}::text))
               || ${extraDelSobre(origen)}::jsonb)::text,
             ${ahora}::timestamptz,
             ${ahora}::timestamptz + make_interval(hours => ${PLAZO_REINTENTOS_HORAS}),
             ${ahora}::timestamptz,
             ${traceparent}::text,
             ${origen.correlationId}::text
        FROM afectadas a`;
  }

  /**
   * Toma hasta `limite` eventos PENDIENTE cuya hora ya llegó y que nadie tiene apartados, les
   * cuenta el intento y los aparta hasta `ahora + arrendamientoSegundos`. Cada fila se elige con
   * FOR UPDATE SKIP LOCKED: dos procesos a la vez nunca toman la misma. El HTTP ocurre después,
   * fuera de toda transacción; si el proceso muere a medio envío, la fila vuelve a estar
   * disponible sola cuando vence el arrendamiento.
   */
  reclamar(ahora: Date, limite: number, arrendamientoSegundos: number): Promise<EventoReclamado[]> {
    return this.prisma.db.$queryRaw<EventoReclamado[]>`
      WITH elegidos AS (
        SELECT e.id_evento
          FROM vuelos.evento_saliente e
         WHERE e.estado = 'PENDIENTE' AND e.proximo_intento <= ${ahora}::timestamptz
           AND (e.arrendamiento_hasta IS NULL OR e.arrendamiento_hasta <= ${ahora}::timestamptz)
         ORDER BY e.proximo_intento, e.creado_en, e.id_evento
         LIMIT ${limite}
           FOR UPDATE OF e SKIP LOCKED
      )
      UPDATE vuelos.evento_saliente e
         SET intentos = e.intentos + 1,
             arrendamiento_hasta = ${ahora}::timestamptz + make_interval(secs => ${arrendamientoSegundos})
        FROM elegidos
       WHERE e.id_evento = elegidos.id_evento
      RETURNING e.id_evento::text AS "idEvento", e.tipo AS "tipo", e.intentos::int AS "intentos",
                e.sobre AS "sobre", e.reintentar_hasta AS "reintentarHasta",
                e.traceparent AS "traceparent",
                e.correlation_id AS "correlationId"`;
  }

  /**
   * Anota cómo salió el intento `intentos`. Condicionado a que la fila siga PENDIENTE y en ese
   * mismo intento: si el arrendamiento venció y otro proceso la retomó, el resultado atrasado no
   * pisa al nuevo. Devuelve el estado en que quedó, o null si no se aplicó.
   */
  async registrarResultado(
    idEvento: string,
    intentos: number,
    ahora: Date,
    resultado: {
      estado: EstadoEventoSaliente;
      codigoHttp: number | null;
      error: string | null;
      proximoIntento: Date | null;
    },
  ): Promise<EstadoEventoSaliente | null> {
    const filas = await this.prisma.db.$queryRaw<Array<{ estado: EstadoEventoSaliente }>>`
      UPDATE vuelos.evento_saliente
         SET estado = ${resultado.estado}::vuelos.estado_evento_saliente,
             proximo_intento = COALESCE(${resultado.proximoIntento}::timestamptz, ${ahora}::timestamptz),
             arrendamiento_hasta = NULL,
             ultimo_codigo_http = ${resultado.codigoHttp}::smallint,
             ultimo_error = ${resultado.error}::text,
             publicado_en = CASE WHEN ${resultado.estado}::text = 'PUBLICADO' THEN ${ahora}::timestamptz END
       WHERE id_evento = ${idEvento}::uuid AND estado = 'PENDIENTE' AND intentos = ${intentos}
      RETURNING estado::text AS estado`;
    return filas[0]?.estado ?? null;
  }

  /**
   * Cuántos eventos están PENDIENTE y desde cuándo espera el más viejo (null si no hay ninguno),
   * para los gauges de /metrics. Una consulta sobre el índice parcial de PENDIENTE, con un plazo
   * en la base (`statement_timeout` de esta transacción): si tarda más, falla en vez de colgar.
   */
  async resumenPendientes(plazoMs: number): Promise<{ pendientes: number; desde: Date | null }> {
    const [, filas] = await this.prisma.db.$transaction([
      this.prisma.db.$executeRaw`SELECT set_config('statement_timeout', ${String(plazoMs)}, true)`,
      this.prisma.db.$queryRaw<Array<{ n: number; desde: Date | null }>>`
        SELECT count(*)::int AS n, min(creado_en) AS desde
          FROM vuelos.evento_saliente WHERE estado = 'PENDIENTE'`,
    ]);
    return { pendientes: filas[0]?.n ?? 0, desde: filas[0]?.desde ?? null };
  }

  /** Desde cuándo espera el evento PENDIENTE más viejo, o null si no hay ninguno. */
  async pendienteMasViejo(): Promise<Date | null> {
    const [fila] = await this.prisma.db.$queryRaw<Array<{ desde: Date | null }>>`
      SELECT min(creado_en) AS desde FROM vuelos.evento_saliente WHERE estado = 'PENDIENTE'`;
    return fila?.desde ?? null;
  }

  /**
   * Borra, como mucho, `limite` eventos ya terminados: los PUBLICADO con publicado_en anterior a
   * `corte`, o los FALLIDO que fallaron (proximo_intento) antes de `corte`. Devuelve cuántos.
   *
   * Un PENDIENTE no entra jamás, ni con el arrendamiento vencido: el relevo puede retomarlo. Por
   * eso cada sentencia nombra el estado dos veces (al elegir y al borrar) y exige que no haya un
   * arrendamiento vigente. FOR UPDATE SKIP LOCKED: una fila que otro proceso tiene tomada (otra
   * purga, reencolar) se salta en vez de esperarla, así dos purgas a la vez se reparten las filas,
   * ninguna borra la misma dos veces y no hay esperas cruzadas. SQL crudo porque deleteMany no
   * admite LIMIT ni SKIP LOCKED; evento_saliente sigue fuera de TABLAS_CON_BORRADO_FISICO.
   */
  purgarLote(
    estado: 'PUBLICADO' | 'FALLIDO',
    corte: Date,
    ahora: Date,
    limite: number,
  ): Promise<number> {
    const db = this.prisma.db;
    return estado === 'PUBLICADO'
      ? db.$executeRaw`
          DELETE FROM vuelos.evento_saliente
           WHERE estado = 'PUBLICADO' AND id_evento IN (
                 SELECT id_evento FROM vuelos.evento_saliente
                  WHERE estado = 'PUBLICADO' AND publicado_en < ${corte}::timestamptz
                    AND (arrendamiento_hasta IS NULL OR arrendamiento_hasta <= ${ahora}::timestamptz)
                  ORDER BY publicado_en, id_evento
                  LIMIT ${limite}
                    FOR UPDATE SKIP LOCKED)`
      : db.$executeRaw`
          DELETE FROM vuelos.evento_saliente
           WHERE estado = 'FALLIDO' AND id_evento IN (
                 SELECT id_evento FROM vuelos.evento_saliente
                  WHERE estado = 'FALLIDO' AND proximo_intento < ${corte}::timestamptz
                    AND (arrendamiento_hasta IS NULL OR arrendamiento_hasta <= ${ahora}::timestamptz)
                  ORDER BY proximo_intento, id_evento
                  LIMIT ${limite}
                    FOR UPDATE SKIP LOCKED)`;
  }
}

export type EstadoEventoSaliente = 'PENDIENTE' | 'PUBLICADO' | 'FALLIDO';

/** Un evento tomado para publicar. */
export interface EventoReclamado {
  idEvento: string;
  tipo: string;
  /** El intento que se está haciendo (1 el primero). */
  intentos: number;
  /** El sobre tal como se guardó: se envía sin tocarlo. */
  sobre: string;
  reintentarHasta: Date;
  /** La traza del hecho que lo originó (null en un evento anterior a la fase 7c). */
  traceparent: string | null;
  /** X-Correlation-Id del hecho: va en la cabecera de la publicación. */
  correlationId: string | null;
}
