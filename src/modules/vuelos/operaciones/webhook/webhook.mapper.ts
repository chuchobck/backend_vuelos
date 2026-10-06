import { WebhookDto } from './dto/webhook.dto';
import { EventoWebhook } from './webhook.modelo';

/** `****` y los últimos 4 caracteres del secreto. */
export function enmascarar(secreto: string): string {
  return `****${secreto.slice(-4)}`;
}

export function aWebhook(suscripcion: {
  id: string;
  url: string;
  eventos: EventoWebhook[];
  secretoEnmascarado: string;
}): WebhookDto {
  return {
    id: suscripcion.id,
    url: suscripcion.url,
    events: suscripcion.eventos,
    secret: suscripcion.secretoEnmascarado,
  };
}
