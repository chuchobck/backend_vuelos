import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reloj } from '../../../../common/reloj';
import { configuracionNotifier } from '../../../../config/eventos';

/** Plazo de un pedido de token: más que esto y se da por fallido. */
export const PLAZO_TOKEN_MS = 3_000;

/** El token se renueva cuando le faltan menos de estos segundos (el reloj puede ir corrido). */
export const MARGEN_RENOVACION_S = 60;

/** Si identity no dice cuánto dura el token (expires_in), lo que dura el suyo: 15 minutos. */
const VIGENCIA_POR_DEFECTO_S = 900;

/** El scope que el notifier exige para POST /internal/v1/events. */
export const SCOPE_PUBLICAR = 'events:publish';

/** No hubo token. `codigo` es corto (TOKEN_HTTP_401, TOKEN_TIMEOUT...) y va a ultimo_error. */
export class TokenNoDisponibleError extends Error {
  constructor(readonly codigo: string) {
    super(`No access token from the identity service (${codigo})`);
    this.name = 'TokenNoDisponibleError';
  }
}

/**
 * El token de acceso con que el core publica en el notifier: client_credentials del cliente
 * core-vuelos (NOTIFIER_CLIENT_ID y NOTIFIER_CLIENT_SECRET) con scope events:publish, pedido a
 * IDENTITY_TOKEN_URL con Authorization: Basic (RFC 6749, 2.3.1). Dura 15 minutos y no hay refresh:
 * se guarda hasta un minuto antes de vencer y entonces se pide otro.
 *
 * - Varios que lo piden a la vez esperan un solo pedido.
 * - Cada pedido tiene 3 s de plazo y no sigue redirecciones.
 * - Un 401 del notifier lo invalida (`invalidar`): el siguiente pide uno nuevo.
 * - Ni el secreto ni el token van nunca al log; un fallo deja solo su código.
 */
@Injectable()
export class ClienteTokenIdentity {
  private readonly logger = new Logger('RelevoEventos');
  private copia: { token: string; venceEnMs: number } | undefined;
  private enCurso: Promise<string> | undefined;

  constructor(
    private readonly config: ConfigService,
    private readonly reloj: Reloj,
  ) {}

  /** Un token vigente: el guardado o uno nuevo. Lanza TokenNoDisponibleError si no lo hay. */
  token(): Promise<string> {
    const ahora = this.reloj.ahora().getTime();
    if (this.copia && ahora < this.copia.venceEnMs - MARGEN_RENOVACION_S * 1000) {
      return Promise.resolve(this.copia.token);
    }
    this.enCurso ??= this.pedir().finally(() => (this.enCurso = undefined));
    return this.enCurso;
  }

  /** Descarta el token guardado (el notifier lo rechazó). Con `token`, solo si es ese. */
  invalidar(token?: string): void {
    if (token === undefined || this.copia?.token === token) this.copia = undefined;
  }

  private async pedir(): Promise<string> {
    const { urlToken, clientId, clientSecret } = configuracionNotifier(this.config);
    const credenciales = Buffer.from(
      `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`,
    ).toString('base64');
    let respuesta: Response;
    try {
      respuesta = await fetch(urlToken, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${credenciales}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({ grant_type: 'client_credentials', scope: SCOPE_PUBLICAR }),
        redirect: 'error',
        signal: AbortSignal.timeout(PLAZO_TOKEN_MS),
      });
    } catch (error) {
      throw this.fallo(codigoDeRed(error));
    }
    if (!respuesta.ok) {
      await respuesta.body?.cancel();
      throw this.fallo(`TOKEN_HTTP_${respuesta.status}`);
    }
    let cuerpo: { access_token?: unknown; expires_in?: unknown };
    try {
      cuerpo = (await respuesta.json()) as typeof cuerpo;
    } catch {
      throw this.fallo('TOKEN_RESPUESTA_INVALIDA');
    }
    if (typeof cuerpo.access_token !== 'string' || cuerpo.access_token === '') {
      throw this.fallo('TOKEN_RESPUESTA_INVALIDA');
    }
    const vigencia =
      typeof cuerpo.expires_in === 'number' && cuerpo.expires_in > 0
        ? cuerpo.expires_in
        : VIGENCIA_POR_DEFECTO_S;
    this.copia = {
      token: cuerpo.access_token,
      venceEnMs: this.reloj.ahora().getTime() + vigencia * 1000,
    };
    this.logger.log(`Token de identity obtenido para publicar eventos (vigente ${vigencia} s)`);
    return cuerpo.access_token;
  }

  private fallo(codigo: string): TokenNoDisponibleError {
    this.logger.warn(`No se pudo obtener el token de identity: ${codigo}`);
    return new TokenNoDisponibleError(codigo);
  }
}

/**
 * Un código corto del error de fetch. Mira `name` y `cause.code`, no `instanceof`: esos errores
 * pueden venir de otro realm (ver claves-jwks.ts).
 */
export function codigoDeRed(error: unknown, prefijo = 'TOKEN_'): string {
  const { name, cause } = (error ?? {}) as { name?: unknown; cause?: { code?: unknown } };
  if (name === 'TimeoutError' || name === 'AbortError') return `${prefijo}TIMEOUT`;
  if (typeof cause?.code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(cause.code)) {
    return `${prefijo}${cause.code}`;
  }
  return `${prefijo}ERROR_DE_RED`;
}
