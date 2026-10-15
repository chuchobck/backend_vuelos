import { ConfigService } from '@nestjs/config';

/**
 * Quién emite los tokens de acceso que la API acepta (AUTH_MODE):
 *
 * - `local` (por defecto): la propia API, con /auth y HS256 con JWT_SECRET (el proveedor de
 *   identidad simulado de RDA1). Todo funciona como antes de existir la variable.
 * - `external`: el servicio de identidad (github.com/chuchobck/identity_vuelos). La API solo
 *   verifica sus tokens RS256 con el JWKS publicado; no monta /auth ni /admin/users.
 */
export const MODOS_AUTH = ['local', 'external'] as const;
export type ModoAuth = (typeof MODOS_AUTH)[number];

/** Ruta del JWKS dentro del emisor (la que publica identity_vuelos). */
export const RUTA_JWKS = '/.well-known/jwks.json';

/** Lo que necesita la verificación externa, ya validado por entorno.ts. */
export interface ConfiguracionExterna {
  /** JWT_ISSUER: el `iss` exacto de los tokens (un origen, sin ruta). */
  emisor: string;
  /** JWT_AUDIENCE: el `aud` que deben traer. */
  audiencia: string;
  /** JWKS_URL, o {JWT_ISSUER}/.well-known/jwks.json. */
  urlJwks: string;
}

export function modoAuth(config: ConfigService): ModoAuth {
  return config.get<string>('AUTH_MODE') === 'external' ? 'external' : 'local';
}

export function configuracionExterna(config: ConfigService): ConfiguracionExterna {
  const emisor = config.getOrThrow<string>('JWT_ISSUER');
  return {
    emisor,
    audiencia: config.getOrThrow<string>('JWT_AUDIENCE'),
    urlJwks: config.get<string>('JWKS_URL') || `${emisor}${RUTA_JWKS}`,
  };
}

/** Una URL http(s) sin usuario ni clave; con `exigirHttps`, solo https. */
function urlSegura(valor: string, exigirHttps: boolean): URL | undefined {
  let url: URL;
  try {
    url = new URL(valor);
  } catch {
    return undefined;
  }
  const protocolos = exigirHttps ? ['https:'] : ['https:', 'http:'];
  if (!protocolos.includes(url.protocol) || url.username !== '' || url.password !== '') {
    return undefined;
  }
  return url;
}

/**
 * El emisor es un origen tal cual (`https://identity.quinde.example`, con puerto si hace falta):
 * sin ruta, barra final, query ni fragmento, y escrito como lo normaliza la URL (minúsculas, sin
 * el puerto por defecto). Es el texto que se compara con el `iss` de cada token, y la base de
 * {JWT_ISSUER}/.well-known/jwks.json.
 */
export function esOrigenEmisor(valor: unknown, exigirHttps: boolean): boolean {
  if (typeof valor !== 'string') return false;
  const url = urlSegura(valor, exigirHttps);
  return url !== undefined && url.origin === valor;
}

/** JWKS_URL: una URL http(s) sin credenciales ni fragmento; https en producción. */
export function esUrlJwks(valor: unknown, exigirHttps: boolean): boolean {
  if (typeof valor !== 'string') return false;
  const url = urlSegura(valor, exigirHttps);
  return url !== undefined && url.hash === '';
}
