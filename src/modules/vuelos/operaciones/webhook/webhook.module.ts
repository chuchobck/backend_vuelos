import { Module } from '@nestjs/common';
import { CifradoSecreto } from './cifrado-secreto';
import { WebhookController } from './webhook.controller';
import { WebhookRepository } from './webhook.repository';
import { WebhookService } from './webhook.service';

/**
 * Suscripciones a webhooks (/webhooks, contrato). webhook_detalle no tiene controller: lo maneja
 * este service. La entrega de eventos y su bandeja (webhook_entrega) se agregan en los pasos
 * siguientes de la fase.
 */
@Module({
  controllers: [WebhookController],
  providers: [WebhookService, WebhookRepository, CifradoSecreto],
  exports: [CifradoSecreto],
})
export class WebhookModule {}
