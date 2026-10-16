import { ConfigService } from '@nestjs/config';

/**
 * Quién reparte los webhooks (WEBHOOKS_MODE):
 *
 * - `local` (por defecto): el propio core, como siempre. PublicadorEventos encola una entrega por
 *   suscripción en webhook_entrega y EntregaWebhooks las envía. /webhooks está montado.
 * - `notifier`: el servicio notifier (github.com/chuchobck/notifier_vuelos). El core guarda UN
 *   sobre por hecho en evento_saliente y RelevoEventos lo publica en POST /internal/v1/events.
 *   /webhooks no se monta (404): las suscripciones las sirve el notifier.
 */
export const MODOS_WEBHOOKS = ['local', 'notifier'] as const;
export type ModoWebhooks = (typeof MODOS_WEBHOOKS)[number];

/** Lo que necesita el relevo hacia el notifier, ya validado por entorno.ts. */
export interface ConfiguracionNotifier {
  /** NOTIFIER_URL, sin barra final: la base de /internal/v1/events. */
  urlNotifier: string;
  /** IDENTITY_TOKEN_URL: el /oauth2/token del servicio de identidad. */
  urlToken: string;
  clientId: string;
  clientSecret: string;
}

export function modoWebhooks(config: ConfigService): ModoWebhooks {
  return config.get<string>('WEBHOOKS_MODE') === 'notifier' ? 'notifier' : 'local';
}

/** WEBHOOKS_MODE=notifier, leído del entorno (para ConditionalModule, antes de ConfigService). */
export function esModoNotifier(entorno: NodeJS.ProcessEnv): boolean {
  return entorno.WEBHOOKS_MODE === 'notifier';
}

export function configuracionNotifier(config: ConfigService): ConfiguracionNotifier {
  return {
    urlNotifier: config.getOrThrow<string>('NOTIFIER_URL').replace(/\/+$/, ''),
    urlToken: config.getOrThrow<string>('IDENTITY_TOKEN_URL'),
    clientId: config.getOrThrow<string>('NOTIFIER_CLIENT_ID'),
    clientSecret: config.getOrThrow<string>('NOTIFIER_CLIENT_SECRET'),
  };
}

/**
 * La URL de un servicio interno: http(s) (solo https con `exigirHttps`), sin usuario ni clave,
 * sin query ni fragmento. Un secreto en la URL acabaría en algún log.
 */
export function esUrlServicio(valor: unknown, exigirHttps: boolean): boolean {
  if (typeof valor !== 'string') return false;
  let url: URL;
  try {
    url = new URL(valor);
  } catch {
    return false;
  }
  const protocolos = exigirHttps ? ['https:'] : ['https:', 'http:'];
  return (
    protocolos.includes(url.protocol) &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === ''
  );
}
