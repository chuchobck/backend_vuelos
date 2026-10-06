import { Injectable } from '@nestjs/common';
import { estado_reserva } from '../../../../generated/prisma/client';
import { TransaccionVuelos } from '../../../../prisma/prisma.service';
import { PublicadorEventos } from '../webhook/publicador-eventos';
import { ReservaRepository } from './reserva.repository';

/**
 * Hechos de una reserva que otros pueden querer saber. Los que tienen el mismo código en
 * tipo_evento (booking.confirmed, booking.failed, booking.ticket_*, booking.baggage_added,
 * booking.changed, booking.cancelled, booking.checked_in) son los que el contrato deja suscribir
 * por webhook. Los
 * demás (booking.created y los pendientes o rechazados de pago, equipaje, cambio y
 * cancelación) no están en ese catálogo: hoy solo van al historial.
 */
export type TipoEventoReserva =
  | 'booking.created'
  | 'booking.payment_pending'
  | 'booking.ticket_issuing'
  | 'booking.ticket_issued'
  | 'booking.ticket_failed'
  | 'booking.confirmed'
  | 'booking.failed'
  | 'booking.baggage_added'
  | 'booking.baggage_pending'
  | 'booking.baggage_rejected'
  | 'booking.changed'
  | 'booking.change_pending'
  | 'booking.change_failed'
  | 'booking.cancelled'
  | 'booking.cancellation_pending'
  | 'booking.checked_in';

export interface EventoReserva {
  tipo: TipoEventoReserva;
  /** Texto en inglés que ve el cliente en BookingDetail.changes; sin datos personales. */
  descripcion: string;
  /** Si el evento es un cambio de estado de la reserva. */
  transicion?: { anterior: estado_reserva | null; nuevo: estado_reserva };
  fecha: Date;
}

/**
 * Punto único por donde pasan los eventos de la reserva, siempre dentro de la transacción del
 * cambio. Los deja en el historial (reserva_detalle_historial, el `changes` del contrato) y, si
 * son de los 12 que el contrato deja suscribir, encola su entrega a los webhooks del dueño
 * (PublicadorEventos, webhook_entrega). Quien emite el evento no cambia.
 */
@Injectable()
export class EventosReserva {
  constructor(
    private readonly repositorio: ReservaRepository,
    private readonly publicador: PublicadorEventos,
  ) {}

  async registrar(tx: TransaccionVuelos, reservaId: string, evento: EventoReserva): Promise<void> {
    await this.repositorio.agregarHistorial(tx, reservaId, {
      anterior: evento.transicion?.anterior ?? null,
      nuevo: evento.transicion?.nuevo ?? null,
      descripcion: evento.descripcion,
      fecha: evento.fecha,
    });
    // Los webhooks: una entrega PENDIENTE por suscripción del dueño, en esta misma transacción
    await this.publicador.deReserva(tx, reservaId, evento.tipo, evento.fecha);
  }
}
