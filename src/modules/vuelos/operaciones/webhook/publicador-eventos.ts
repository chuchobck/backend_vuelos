import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { modoWebhooks } from '../../../../config/eventos';
import { traceparentActivo } from '../../../../observabilidad/contexto-traza';
import { TransaccionVuelos } from '../../../../prisma/prisma.service';
import { ESTADO_RESERVA } from '../../compartido/enums';
import { BandejaEventosRepository } from './bandeja-eventos.repository';
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
 * la transacción del hecho (así el evento y su entrega confirman o se deshacen juntos) y nunca
 * hace HTTP. Un evento que no es de los 12 suscribibles se ignora. Según WEBHOOKS_MODE:
 *
 * - local (por defecto): escribe una fila PENDIENTE en webhook_entrega por cada suscripción del
 *   dueño que escucha el evento; las envía EntregaWebhooks, aparte.
 * - notifier: escribe UNA fila en evento_saliente con el sobre congelado y el `traceparent` del
 *   contexto activo (la traza del hecho); la publica RelevoEventos al notifier, que reparte a las
 *   suscripciones. La entrega a terceros (local) nunca lleva traceparent.
 *
 * Las firmas son las mismas en los dos modos: quien publica no sabe cuál está activo.
 */
@Injectable()
export class PublicadorEventos {
  private readonly alNotifier: boolean;

  constructor(
    private readonly entregas: EntregaRepository,
    private readonly bandeja: BandejaEventosRepository,
    config: ConfigService,
  ) {
    this.alNotifier = modoWebhooks(config) === 'notifier';
  }

  /** Un evento de la reserva (booking.*), a las suscripciones de su dueño. */
  async deReserva(
    tx: TransaccionVuelos,
    reservaId: string,
    tipo: string,
    ahora: Date,
  ): Promise<void> {
    if (!esSuscribible(tipo)) return;
    if (this.alNotifier) {
      await this.bandeja.guardarDeReserva(
        tx,
        reservaId,
        tipo,
        ahora,
        randomUUID(),
        ESTADOS_DEL_CONTRATO,
        traceparentActivo(),
      );
      return;
    }
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
    if (this.alNotifier) {
      await this.bandeja.guardarDeRetencion(
        tx,
        retencionId,
        ahora,
        randomUUID(),
        traceparentActivo(),
      );
      return;
    }
    await this.entregas.encolarDeRetencion(tx, retencionId, ahora, randomUUID());
  }

  /** flight.schedule_changed o flight.cancelled, a los dueños de las reservas vivas de esa salida. */
  async deVuelo(
    tx: TransaccionVuelos,
    salidaId: string,
    tipo: 'flight.schedule_changed' | 'flight.cancelled',
    ahora: Date,
  ): Promise<void> {
    if (this.alNotifier) {
      await this.bandeja.guardarDeVuelo(
        tx,
        salidaId,
        tipo,
        ahora,
        ESTADOS_DEL_CONTRATO,
        traceparentActivo(),
      );
      return;
    }
    await this.entregas.encolarDeVuelo(tx, salidaId, tipo, ahora, ESTADOS_DEL_CONTRATO);
  }
}

function esSuscribible(tipo: string): boolean {
  return (EVENTOS_WEBHOOK as readonly string[]).includes(tipo);
}
