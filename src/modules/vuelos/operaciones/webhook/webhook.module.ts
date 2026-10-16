import { Module } from '@nestjs/common';
import { BandejaEventosRepository } from './bandeja-eventos.repository';
import { CifradoSecreto } from './cifrado-secreto';
import { ClienteWebhook } from './cliente-webhook';
import { ClienteWebhookHttp } from './cliente-webhook-http';
import { EntregaRepository } from './entrega.repository';
import { EntregaWebhooks } from './entrega-webhooks';
import { PublicadorEventos } from './publicador-eventos';

/**
 * Lo que los hechos de negocio necesitan de los webhooks, en los dos modos de WEBHOOKS_MODE:
 * PublicadorEventos (por donde llegan, dentro de su transacción), la bandeja de cada modo
 * (webhook_entrega en local, evento_saliente con notifier) y EntregaWebhooks, que envía las
 * entregas de webhook_entrega fuera de toda transacción (con notifier, solo drena las que ya
 * había). Las rutas /webhooks están en WebhookApiModule.
 */
@Module({
  providers: [
    CifradoSecreto,
    EntregaRepository,
    BandejaEventosRepository,
    PublicadorEventos,
    EntregaWebhooks,
    { provide: ClienteWebhook, useClass: ClienteWebhookHttp },
  ],
  exports: [CifradoSecreto, PublicadorEventos, EntregaRepository, BandejaEventosRepository],
})
export class WebhookModule {}
