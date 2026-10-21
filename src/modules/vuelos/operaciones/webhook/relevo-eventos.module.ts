import { Module } from '@nestjs/common';
import { MetricasBandeja } from '../../../../observabilidad/metricas-bandeja';
import { ClienteNotifier } from './cliente-notifier';
import { ClienteTokenIdentity } from './cliente-token-identity';
import { RelevoEventos } from './relevo-eventos';
import { WebhookModule } from './webhook.module';

/**
 * El relevo de la bandeja evento_saliente al notifier. Solo se importa con WEBHOOKS_MODE=notifier
 * (OperacionesModule): en local no existe, y ni el token ni el notifier se tocan.
 */
@Module({
  imports: [WebhookModule],
  providers: [ClienteTokenIdentity, ClienteNotifier, RelevoEventos, MetricasBandeja],
})
export class RelevoEventosModule {}
