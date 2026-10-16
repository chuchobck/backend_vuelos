import { Module } from '@nestjs/common';
import { ClienteNotifier } from './cliente-notifier';
import { ClienteTokenIdentity } from './cliente-token-identity';
import { PurgaBandeja } from './purga-bandeja';
import { RelevoEventos } from './relevo-eventos';
import { WebhookModule } from './webhook.module';

/**
 * El relevo de la bandeja evento_saliente al notifier y su purga. Solo se importa con WEBHOOKS_MODE=notifier
 * (OperacionesModule): en local no existe, y ni el token ni el notifier se tocan.
 */
@Module({
  imports: [WebhookModule],
  providers: [ClienteTokenIdentity, ClienteNotifier, RelevoEventos, PurgaBandeja],
})
export class RelevoEventosModule {}
