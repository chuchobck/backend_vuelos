import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { correlacionActual } from '../../../../common/contexto/correlation-id';
import { modoWebhooks } from '../../../../config/eventos';
import { traceparentActivo } from '../../../../observabilidad/contexto-traza';
import { TransaccionVuelos } from '../../../../prisma/prisma.service';
import { ESTADO_RESERVA } from '../../compartido/enums';
import { BandejaEventosRepository, OrigenEvento } from './bandeja-eventos.repository';
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
 * Las firmas son las mismas en los dos modos: quien publica no sabe cuál está activo. En modo
 * notifier cada evento guarda el X-Correlation-Id de la petición del hecho (y, con
 * EVENT_ENVELOPE_CORRELATION_ID=true, lo lleva también en el sobre).
 */
@Injectable()
export class PublicadorEventos {
  private readonly alNotifier: boolean;
  private readonly correlacionEnSobre: boolean;

  constructor(
    private readonly entregas: EntregaRepository,
    private readonly bandeja: BandejaEventosRepository,
    config: ConfigService,
  ) {
    this.alNotifier = modoWebhooks(config) === 'notifier';
    this.correlacionEnSobre = config.get<string>('EVENT_ENVELOPE_CORRELATION_ID') === 'true';
  }

  private origen(): OrigenEvento {
    return { correlationId: correlacionActual() ?? null, enSobre: this.correlacionEnSobre };
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
        this.origen(),
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
        this.origen(),
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
        this.origen(),
      );
      return;
    }
    await this.entregas.encolarDeVuelo(tx, salidaId, tipo, ahora, ESTADOS_DEL_CONTRATO);
  }
}

function esSuscribible(tipo: string): boolean {
  return (EVENTOS_WEBHOOK as readonly string[]).includes(tipo);
}
