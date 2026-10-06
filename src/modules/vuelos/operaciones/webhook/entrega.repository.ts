import { Injectable } from '@nestjs/common';
import { PrismaService, TransaccionVuelos } from '../../../../prisma/prisma.service';
import { ActorAuditoria } from '../../../../prisma/extensiones/transaccion-auditada';

/** Los procesos internos escriben sin usuario ni IP. */
const ACTOR_SISTEMA: ActorAuditoria = { idUsuario: null, direccionIp: null };

/** Versión de la API que se anuncia en el payload (info.version del contrato, sin el cuarto número). */
export const VERSION_API = '1.5.0';

/**
 * La bandeja de salida (webhook_entrega): encola una entrega PENDIENTE por cada suscripción
 * activa del dueño que escucha el evento, en la misma transacción del hecho de negocio. Cada
 * método es UN solo INSERT ... SELECT: si el dueño no tiene suscriptores, no inserta nada. El
 * unique (webhook_id, id_evento) hace que encolar dos veces el mismo evento no duplique.
 *
 * El payload (WebhookPayload) se arma aquí y queda congelado: un reintento envía el mismo cuerpo.
 * No lleva datos personales: PNR, ids públicos, estado y, al cancelar, el monto reembolsado.
 */
@Injectable()
export class EntregaRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Un evento de una reserva (booking.*). `estados` traduce el estado de la base al del
   * contrato (BookingDetail.status) y se aplica al estado que la reserva tiene ahora. Si es
   * booking.cancelled, agrega el reembolso de la cotización aceptada.
   */
  async encolarDeReserva(
    tx: TransaccionVuelos,
    reservaId: string,
    tipo: string,
    ahora: Date,
    eventId: string,
    estados: Record<string, string>,
  ): Promise<number> {
    return tx.$executeRaw`
      INSERT INTO vuelos.webhook_entrega
             (webhook_id, id_evento, tipo_evento_id, payload, proximo_intento, fecha_creacion, fecha_actualizacion)
      SELECT w.id, ${eventId}::uuid, t.id,
             jsonb_build_object(
               'eventId', ${eventId}::text, 'eventType', ${tipo}::text,
               'occurredAt', to_char(${ahora}::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'apiVersion', ${VERSION_API}::text,
               'data', jsonb_strip_nulls(jsonb_build_object(
                 'bookingId', rc.id::text, 'pnr', rc.pnr,
                 'status', ${JSON.stringify(estados)}::jsonb ->> rc.estado::text,
                 'refundAmount', (SELECT to_char(c.monto_reembolso, 'FM999999990.00')
                                    FROM vuelos.cotizacion_cancelacion c
                                   WHERE c.reserva_id = rc.id AND c.fecha_aceptacion IS NOT NULL
                                     AND ${tipo}::text = 'booking.cancelled')))),
             ${ahora}::timestamptz, ${ahora}::timestamptz, ${ahora}::timestamptz
        FROM vuelos.reserva_cabecera rc
        JOIN vuelos.retencion_cabecera r ON r.id = rc.retencion_id
        JOIN vuelos.webhook_cabecera w   ON w.id_propietario = r.id_propietario AND w.activo
        JOIN vuelos.webhook_detalle d    ON d.webhook_id = w.id
        JOIN vuelos.tipo_evento t        ON t.id = d.tipo_evento_id AND t.codigo = ${tipo}
       WHERE rc.id = ${reservaId}::uuid
      ON CONFLICT ON CONSTRAINT uq_webhook_entrega_evento DO NOTHING`;
  }

  /** hold.expired: el dueño del hold que venció. */
  async encolarDeRetencion(
    tx: TransaccionVuelos,
    retencionId: string,
    ahora: Date,
    eventId: string,
  ): Promise<number> {
    return tx.$executeRaw`
      INSERT INTO vuelos.webhook_entrega
             (webhook_id, id_evento, tipo_evento_id, payload, proximo_intento, fecha_creacion, fecha_actualizacion)
      SELECT w.id, ${eventId}::uuid, t.id,
             jsonb_build_object(
               'eventId', ${eventId}::text, 'eventType', 'hold.expired',
               'occurredAt', to_char(${ahora}::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'apiVersion', ${VERSION_API}::text,
               'data', jsonb_build_object('holdId', r.id::text, 'status', 'EXPIRED')),
             ${ahora}::timestamptz, ${ahora}::timestamptz, ${ahora}::timestamptz
        FROM vuelos.retencion_cabecera r
        JOIN vuelos.webhook_cabecera w ON w.id_propietario = r.id_propietario AND w.activo
        JOIN vuelos.webhook_detalle d  ON d.webhook_id = w.id
        JOIN vuelos.tipo_evento t      ON t.id = d.tipo_evento_id AND t.codigo = 'hold.expired'
       WHERE r.id = ${retencionId}::uuid
      ON CONFLICT ON CONSTRAINT uq_webhook_entrega_evento DO NOTHING`;
  }

  /**
   * flight.schedule_changed o flight.cancelled: una entrega por cada reserva viva (ni cancelada
   * ni fallida) que vuela en esa salida y por cada suscripción de su dueño. Cada reserva es un
   * evento distinto, con su propio eventId.
   */
  async encolarDeVuelo(
    tx: TransaccionVuelos,
    salidaId: string,
    tipo: string,
    ahora: Date,
    estados: Record<string, string>,
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
      INSERT INTO vuelos.webhook_entrega
             (webhook_id, id_evento, tipo_evento_id, payload, proximo_intento, fecha_creacion, fecha_actualizacion)
      SELECT w.id, a.evento, t.id,
             jsonb_build_object(
               'eventId', a.evento::text, 'eventType', ${tipo}::text,
               'occurredAt', to_char(${ahora}::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'apiVersion', ${VERSION_API}::text,
               'data', jsonb_build_object(
                 'bookingId', a.id::text, 'pnr', a.pnr,
                 'status', ${JSON.stringify(estados)}::jsonb ->> a.estado::text,
                 'flightNumber', a.vuelo, 'segmentId', ${salidaId}::text)),
             ${ahora}::timestamptz, ${ahora}::timestamptz, ${ahora}::timestamptz
        FROM afectadas a
        JOIN vuelos.webhook_cabecera w ON w.id_propietario = a.id_propietario AND w.activo
        JOIN vuelos.webhook_detalle d  ON d.webhook_id = w.id
        JOIN vuelos.tipo_evento t      ON t.id = d.tipo_evento_id AND t.codigo = ${tipo}
      ON CONFLICT ON CONSTRAINT uq_webhook_entrega_evento DO NOTHING`;
  }

  /**
   * Toma hasta `limite` entregas PENDIENTE cuya hora ya llegó y les cuenta el intento. Cada fila
   * se elige con FOR UPDATE SKIP LOCKED: dos procesos a la vez nunca toman la misma. Al tomarla
   * se le corre `proximo_intento` al fin del arrendamiento (`ahora + arrendamientoSegundos`),
   * así el envío HTTP ocurre FUERA de toda transacción y, si el proceso muere a medio envío, la
   * entrega vuelve a estar disponible sola cuando el arrendamiento vence (el intento ya contó).
   */
  async reclamar(
    ahora: Date,
    limite: number,
    arrendamientoSegundos: number,
  ): Promise<EntregaReclamada[]> {
    return this.prisma.db.$queryRaw<EntregaReclamada[]>`
      WITH elegidas AS (
        SELECT e.id
          FROM vuelos.webhook_entrega e
         WHERE e.estado = 'PENDIENTE' AND e.proximo_intento <= ${ahora}::timestamptz
         ORDER BY e.proximo_intento, e.id
         LIMIT ${limite}
           FOR UPDATE OF e SKIP LOCKED
      ), reclamadas AS (
        UPDATE vuelos.webhook_entrega e
           SET intentos = e.intentos + 1,
               proximo_intento = ${ahora}::timestamptz + make_interval(secs => ${arrendamientoSegundos}),
               fecha_actualizacion = ${ahora}::timestamptz
          FROM elegidas
         WHERE e.id = elegidas.id
        RETURNING e.id, e.webhook_id, e.id_evento, e.tipo_evento_id, e.intentos, e.payload
      )
      SELECT r.id AS "id", r.webhook_id AS "webhookId", r.id_evento AS "eventId",
             t.codigo AS "tipo", r.intentos::int AS "intentos", r.payload AS "payload",
             w.url AS "url", w.secreto AS "secretoCifrado", w.activo AS "suscripcionActiva"
        FROM reclamadas r
        JOIN vuelos.webhook_cabecera w ON w.id = r.webhook_id
        JOIN vuelos.tipo_evento t      ON t.id = r.tipo_evento_id
       ORDER BY r.id`;
  }

  /**
   * Anota cómo salió el intento `intentos` de la entrega. UPDATE condicionado a que la fila siga
   * PENDIENTE y en ese mismo intento: si el arrendamiento venció y otro proceso la retomó, el
   * resultado atrasado no pisa al nuevo. `proximoIntento` null con fallo = FALLIDO definitivo. En
   * un estado final `proximo_intento` queda en la hora del último intento (no en la del arrendamiento).
   * Devuelve el estado en que quedó, o null si no se aplicó.
   */
  async registrarResultado(
    id: bigint,
    intentos: number,
    ahora: Date,
    resultado: { codigoHttp: number | null; error: string | null },
    proximoIntento: Date | null,
  ): Promise<EstadoEntrega | null> {
    const exito =
      resultado.codigoHttp !== null && resultado.codigoHttp >= 200 && resultado.codigoHttp < 300;
    const filas = await this.prisma.db.$queryRaw<Array<{ estado: EstadoEntrega }>>`
      UPDATE vuelos.webhook_entrega
         SET estado = (CASE WHEN ${exito} THEN 'ENTREGADO'
                            WHEN ${proximoIntento}::timestamptz IS NULL THEN 'FALLIDO'
                            ELSE 'PENDIENTE' END)::vuelos.estado_entrega_webhook,
             proximo_intento = COALESCE(${proximoIntento}::timestamptz, ${ahora}::timestamptz),
             ultimo_codigo_http = ${resultado.codigoHttp}::smallint,
             ultimo_error = ${exito ? null : (resultado.error ?? 'HTTP_' + resultado.codigoHttp)}::text,
             fecha_actualizacion = ${ahora}::timestamptz
       WHERE id = ${id} AND estado = 'PENDIENTE' AND intentos = ${intentos}
      RETURNING estado::text AS estado`;
    return filas[0]?.estado ?? null;
  }

  /**
   * Si las últimas `maximo` entregas ya resueltas de la suscripción (ENTREGADO o FALLIDO) son
   * todas FALLIDO, la da de baja (lógica) y lo audita, sin usuario (proceso interno). Una
   * entrega ENTREGADO corta la racha. Devuelve si la dio de baja.
   */
  desactivarSiSoloFalla(webhookId: string, maximo: number): Promise<boolean> {
    return this.prisma.transaccionAuditada(
      async (tx) => {
        const [racha] = await tx.$queryRaw<Array<{ fallidas: number; total: number }>>`
          SELECT count(*) FILTER (WHERE estado::text = 'FALLIDO')::int AS fallidas, count(*)::int AS total
            FROM (SELECT estado
                    FROM vuelos.webhook_entrega
                   WHERE webhook_id = ${webhookId}::uuid AND estado::text <> 'PENDIENTE'
                   ORDER BY fecha_actualizacion DESC, id DESC
                   LIMIT ${maximo}) ultimas`;
        if (racha.total < maximo || racha.fallidas < maximo) return false;
        const { count } = await tx.webhook_cabecera.updateMany({
          where: { id: webhookId, activo: true },
          data: { activo: false },
        });
        return count === 1;
      },
      { actor: ACTOR_SISTEMA },
    );
  }
}

export type EstadoEntrega = 'PENDIENTE' | 'ENTREGADO' | 'FALLIDO';

/** Una entrega tomada para enviar, con lo que hace falta de su suscripción. */
export interface EntregaReclamada {
  id: bigint;
  webhookId: string;
  eventId: string;
  tipo: string;
  /** el intento que se está haciendo (1 el primero) */
  intentos: number;
  payload: Record<string, unknown>;
  url: string;
  secretoCifrado: string;
  suscripcionActiva: boolean;
}
