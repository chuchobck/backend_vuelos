import { Module } from '@nestjs/common';
import { CifradoSecreto } from './cifrado-secreto';
import { EntregaRepository } from './entrega.repository';
import { PublicadorEventos } from './publicador-eventos';
import { WebhookController } from './webhook.controller';
import { WebhookRepository } from './webhook.repository';
import { WebhookService } from './webhook.service';

/**
 * Suscripciones a webhooks (/webhooks, contrato). webhook_detalle no tiene controller: lo maneja
 * este service. PublicadorEventos es por donde los hechos de negocio (reserva, hold, vuelo)
 * llegan a la bandeja de salida (webhook_entrega), dentro de su transacción.
 */
@Module({
  controllers: [WebhookController],
  providers: [
    WebhookService,
    WebhookRepository,
    CifradoSecreto,
    EntregaRepository,
    PublicadorEventos,
  ],
  exports: [CifradoSecreto, PublicadorEventos, EntregaRepository],
})
export class WebhookModule {}
