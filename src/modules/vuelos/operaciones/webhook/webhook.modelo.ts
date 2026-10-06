/**
 * Los 12 tipos de evento que el contrato deja suscribir (WebhookSubscription.events) y que
 * `tipo_evento` trae como datos fijos. El orden es el del contrato.
 */
export const EVENTOS_WEBHOOK = [
  'booking.confirmed',
  'booking.failed',
  'booking.changed',
  'booking.cancelled',
  'booking.baggage_added',
  'hold.expired',
  'flight.schedule_changed',
  'flight.cancelled',
  'booking.ticket_issuing',
  'booking.ticket_issued',
  'booking.ticket_failed',
  'booking.checked_in',
] as const;

export type EventoWebhook = (typeof EVENTOS_WEBHOOK)[number];

/** Una suscripción activa de un usuario. El secreto llega cifrado; el repository no lo ve en claro. */
export interface Suscripcion {
  id: string;
  url: string;
  eventos: EventoWebhook[];
  /** El secreto cifrado (`v1.…`), tal como está en la base. */
  secretoCifrado: string;
}

/** Máximo de suscripciones activas por usuario. */
export const MAXIMO_SUSCRIPCIONES_ACTIVAS = 10;
