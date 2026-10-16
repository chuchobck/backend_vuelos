import { Module } from '@nestjs/common';
import { WebhookController } from './webhook.controller';
import { WebhookModule } from './webhook.module';
import { WebhookRepository } from './webhook.repository';
import { WebhookService } from './webhook.service';

/**
 * Las suscripciones a webhooks (GET/POST/DELETE /webhooks, contrato). webhook_detalle no tiene
 * controller: lo maneja este service. Solo se monta con WEBHOOKS_MODE=local (OperacionesModule):
 * con notifier esas rutas las sirve el notifier y aquí dan 404.
 */
@Module({
  imports: [WebhookModule],
  controllers: [WebhookController],
  providers: [WebhookService, WebhookRepository],
})
export class WebhookApiModule {}
