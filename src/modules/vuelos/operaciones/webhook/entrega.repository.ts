import { Injectable } from '@nestjs/common';
import { TransaccionVuelos } from '../../../../prisma/prisma.service';

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
}
