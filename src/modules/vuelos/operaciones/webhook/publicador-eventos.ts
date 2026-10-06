import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TransaccionVuelos } from '../../../../prisma/prisma.service';
import { ESTADO_RESERVA } from '../../compartido/enums';
import { EntregaRepository } from './entrega.repository';
import { EVENTOS_WEBHOOK } from './webhook.modelo';

/** estado_reserva de la base → BookingDetail.status del contrato, para el payload. */
const ESTADOS_DEL_CONTRATO: Record<string, string> = Object.fromEntries(
  (
    [
      'PENDIENTE',
      'PENDIENTE_PAGO',
      'EMITIENDO_BOLETOS',
      'CONFIRMADA',
      'FALLIDA',
      'CAMBIO_PENDIENTE',
      'CANCELACION_PENDIENTE',
      'CANCELADA',
    ] as const
  ).map((e) => [e, ESTADO_RESERVA.aContrato(e)]),
);

/**
 * El punto por donde los hechos de negocio llegan a los webhooks. Cada método se llama DENTRO de
 * la transacción del hecho (así el evento y su entrega confirman o se deshacen juntos) y solo
 * escribe filas PENDIENTE en webhook_entrega: el envío HTTP lo hace EntregaWebhooks, aparte.
 * Un evento que no es de los 12 suscribibles se ignora.
 */
@Injectable()
export class PublicadorEventos {
  constructor(private readonly entregas: EntregaRepository) {}

  /** Un evento de la reserva (booking.*), a las suscripciones de su dueño. */
  async deReserva(
    tx: TransaccionVuelos,
    reservaId: string,
    tipo: string,
    ahora: Date,
  ): Promise<void> {
    if (!esSuscribible(tipo)) return;
    await this.entregas.encolarDeReserva(
      tx,
      reservaId,
      tipo,
      ahora,
      randomUUID(),
      ESTADOS_DEL_CONTRATO,
    );
  }

  /** hold.expired, al dueño del hold. */
  async deRetencionVencida(tx: TransaccionVuelos, retencionId: string, ahora: Date): Promise<void> {
    await this.entregas.encolarDeRetencion(tx, retencionId, ahora, randomUUID());
  }

  /** flight.schedule_changed o flight.cancelled, a los dueños de las reservas vivas de esa salida. */
  async deVuelo(
    tx: TransaccionVuelos,
    salidaId: string,
    tipo: 'flight.schedule_changed' | 'flight.cancelled',
    ahora: Date,
  ): Promise<void> {
    await this.entregas.encolarDeVuelo(tx, salidaId, tipo, ahora, ESTADOS_DEL_CONTRATO);
  }
}

function esSuscribible(tipo: string): boolean {
  return (EVENTOS_WEBHOOK as readonly string[]).includes(tipo);
}
