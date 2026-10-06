import { Injectable } from '@nestjs/common';
import { estado_reserva } from '../../../../generated/prisma/client';
import { TransaccionVuelos } from '../../../../prisma/prisma.service';
import { ReservaRepository } from './reserva.repository';

/**
 * Hechos de una reserva que otros pueden querer saber. Los que tienen el mismo código en
 * tipo_evento (booking.confirmed, booking.failed, booking.ticket_*) son los que el contrato deja
 * suscribir por webhook; booking.created y booking.payment_pending no están en ese catálogo.
 */
export type TipoEventoReserva =
  | 'booking.created'
  | 'booking.payment_pending'
  | 'booking.ticket_issuing'
  | 'booking.ticket_issued'
  | 'booking.ticket_failed'
  | 'booking.confirmed'
  | 'booking.failed';

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
 * cambio. Hoy solo los deja en el historial (reserva_detalle_historial, el `changes` del
 * contrato). La fase 10 agrega aquí la bandeja de salida de webhooks (tabla `evento`) sin tocar
 * a quien los emite.
 */
@Injectable()
export class EventosReserva {
  constructor(private readonly repositorio: ReservaRepository) {}

  async registrar(tx: TransaccionVuelos, reservaId: string, evento: EventoReserva): Promise<void> {
    await this.repositorio.agregarHistorial(tx, reservaId, {
      anterior: evento.transicion?.anterior ?? null,
      nuevo: evento.transicion?.nuevo ?? null,
      descripcion: evento.descripcion,
      fecha: evento.fecha,
    });
  }
}
