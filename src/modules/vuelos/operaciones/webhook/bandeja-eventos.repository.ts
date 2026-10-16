import { Injectable } from '@nestjs/common';
import { TransaccionVuelos } from '../../../../prisma/prisma.service';

/** schemaVersion del sobre: el menor de la v1 de los esquemas del notifier (contracts/notifier-eventos). */
export const VERSION_ESQUEMA_EVENTOS = '1.0';

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
  /** Un evento booking.*; `estados` traduce el estado de la base al del contrato. */
  guardarDeReserva(
    tx: TransaccionVuelos,
    reservaId: string,
    tipo: string,
    ahora: Date,
    eventId: string,
    estados: Record<string, string>,
  ): Promise<number> {
    return tx.$executeRaw`
      INSERT INTO vuelos.evento_saliente
             (id_evento, tipo, id_propietario, sobre, proximo_intento, reintentar_hasta, creado_en)
      SELECT ${eventId}::uuid, ${tipo}::text, r.id_propietario,
             jsonb_build_object(
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
                                     AND ${tipo}::text = 'booking.cancelled'))))::text,
             ${ahora}::timestamptz,
             ${ahora}::timestamptz + make_interval(hours => ${PLAZO_REINTENTOS_HORAS}),
             ${ahora}::timestamptz
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
  ): Promise<number> {
    return tx.$executeRaw`
      INSERT INTO vuelos.evento_saliente
             (id_evento, tipo, id_propietario, sobre, proximo_intento, reintentar_hasta, creado_en)
      SELECT ${eventId}::uuid, 'hold.expired', r.id_propietario,
             jsonb_build_object(
               'eventId', ${eventId}::text, 'eventType', 'hold.expired',
               'schemaVersion', ${VERSION_ESQUEMA_EVENTOS}::text,
               'occurredAt', to_char(${ahora}::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'ownerId', r.id_propietario,
               'data', jsonb_build_object('holdId', r.id::text, 'status', 'EXPIRED'))::text,
             ${ahora}::timestamptz,
             ${ahora}::timestamptz + make_interval(hours => ${PLAZO_REINTENTOS_HORAS}),
             ${ahora}::timestamptz
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
             (id_evento, tipo, id_propietario, sobre, proximo_intento, reintentar_hasta, creado_en)
      SELECT a.evento, ${tipo}::text, a.id_propietario,
             jsonb_build_object(
               'eventId', a.evento::text, 'eventType', ${tipo}::text,
               'schemaVersion', ${VERSION_ESQUEMA_EVENTOS}::text,
               'occurredAt', to_char(${ahora}::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'ownerId', a.id_propietario,
               'data', jsonb_build_object(
                 'bookingId', a.id::text, 'pnr', a.pnr,
                 'status', ${JSON.stringify(estados)}::jsonb ->> a.estado::text,
                 'flightNumber', a.vuelo, 'segmentId', ${salidaId}::text))::text,
             ${ahora}::timestamptz,
             ${ahora}::timestamptz + make_interval(hours => ${PLAZO_REINTENTOS_HORAS}),
             ${ahora}::timestamptz
        FROM afectadas a`;
  }
}
