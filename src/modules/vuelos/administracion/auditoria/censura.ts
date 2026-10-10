/**
 * Censura de los datos que la auditoría copia de cada fila (`datos_anteriores` y
 * `datos_nuevos`) antes de entregarlos a un administrador.
 *
 * El disparador `fn_auditar` ya enmascara `secreto` y `hash_contrasena` al escribir, pero esta
 * capa no confía en eso: una tabla nueva con otro nombre de columna, o un script que escriba
 * sin pasar por el disparador, no debe filtrar un secreto por la API.
 */

/**
 * Fragmentos de nombre de columna (en minúsculas) cuyo valor nunca sale por la API. Un nombre
 * se censura si CONTIENE alguno (`refresh_token`, `webhook_secret` y `hash_token` incluidos):
 * ante la duda se censura de más, no de menos. Es el único lugar donde se define la lista.
 */
export const CLAVES_SENSIBLES = [
  'hash_contrasena',
  'password',
  'contrasena',
  'hash_token',
  'token',
  'refresh',
  'secret',
  'secreto',
  'authorization',
] as const;

/** Lo que reemplaza al valor censurado. */
export const VALOR_CENSURADO = '[REDACTED]';

/** Un JSON ya leído de la base: lo único que puede traer una columna jsonb. */
export type ValorJson =
  string | number | boolean | null | ValorJson[] | { [clave: string]: ValorJson };

/** Hash argon2id en formato PHC o JWT (tres tramos base64url que empiezan por `eyJ`). */
const PARECE_SECRETO = /^\$argon2|^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/** Hasta dónde se baja por objetos anidados; más profundo se censura entero. */
const PROFUNDIDAD_MAXIMA = 32;

export function esClaveSensible(clave: string): boolean {
  const normalizada = clave.toLowerCase();
  return CLAVES_SENSIBLES.some((fragmento) => normalizada.includes(fragmento));
}

/**
 * Copia del JSON con `[REDACTED]` en el valor de toda clave sensible, a cualquier profundidad
 * (objetos dentro de arreglos incluidos), y en todo texto que parezca un hash de contraseña o
 * un JWT aunque su clave no lo diga. No modifica el original.
 */
export function censurar(valor: ValorJson, profundidad = 0): ValorJson {
  if (profundidad > PROFUNDIDAD_MAXIMA) return VALOR_CENSURADO;
  if (typeof valor === 'string') return PARECE_SECRETO.test(valor) ? VALOR_CENSURADO : valor;
  if (Array.isArray(valor)) return valor.map((elemento) => censurar(elemento, profundidad + 1));
  if (valor !== null && typeof valor === 'object') {
    const copia: { [clave: string]: ValorJson } = {};
    for (const [clave, contenido] of Object.entries(valor)) {
      copia[clave] = esClaveSensible(clave)
        ? VALOR_CENSURADO
        : censurar(contenido, profundidad + 1);
    }
    return copia;
  }
  return valor;
}
