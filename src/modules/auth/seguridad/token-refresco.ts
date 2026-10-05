import { createHash, randomBytes } from 'node:crypto';

/** Vigencia de cada token de refresco. Cada rotación entrega uno nuevo con 7 días más. */
export const VIGENCIA_REFRESCO_SEGUNDOS = 7 * 24 * 60 * 60;

/** 32 bytes = 256 bits aleatorios; en base64url quedan 43 caracteres. */
const BYTES_TOKEN = 32;
const FORMATO_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface TokenRefrescoNuevo {
  /** Lo que recibe el cliente, una sola vez. */
  token: string;
  /** Lo único que se guarda (token_refresco.hash_token). */
  hash: string;
}

/**
 * Token de refresco opaco: no es un JWT, no lleva datos y solo sirve para buscar su fila.
 * Se guarda su SHA-256 y no un hash lento como argon2: con 256 bits aleatorios no hay
 * diccionario que probar, y un hash determinista permite buscarlo por índice único.
 */
export function generarTokenRefresco(): TokenRefrescoNuevo {
  const token = randomBytes(BYTES_TOKEN).toString('base64url');
  return { token, hash: hashearTokenRefresco(token) };
}

export function hashearTokenRefresco(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Descarta antes de ir a la base lo que no puede ser un token emitido por la API. */
export function tieneFormatoDeTokenRefresco(valor: unknown): valor is string {
  return typeof valor === 'string' && FORMATO_TOKEN.test(valor);
}
