import { Module } from '@nestjs/common';
import { CifradoSecreto } from './cifrado-secreto';
import { ClienteWebhook } from './cliente-webhook';
import { ClienteWebhookHttp } from './cliente-webhook-http';
import { EntregaRepository } from './entrega.repository';
import { EntregaWebhooks } from './entrega-webhooks';
import { PublicadorEventos } from './publicador-eventos';
import { WebhookController } from './webhook.controller';
import { WebhookRepository } from './webhook.repository';
import { WebhookService } from './webhook.service';

/**
 * Suscripciones a webhooks (/webhooks, contrato). webhook_detalle no tiene controller: lo maneja
 * este service. PublicadorEventos es por donde los hechos de negocio (reserva, hold, vuelo)
 * llegan a la bandeja de salida (webhook_entrega), dentro de su transacción; EntregaWebhooks la
 * vacía enviando los POST firmados, fuera de toda transacción.
 */
@Module({
  controllers: [WebhookController],
  providers: [
    WebhookService,
    WebhookRepository,
    CifradoSecreto,
    EntregaRepository,
    PublicadorEventos,
    EntregaWebhooks,
    { provide: ClienteWebhook, useClass: ClienteWebhookHttp },
  ],
  exports: [CifradoSecreto, PublicadorEventos, EntregaRepository],
})
export class WebhookModule {}
