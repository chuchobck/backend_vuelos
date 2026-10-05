import * as parametros from './parametros-argon2.json';

/**
 * Parámetros de argon2id para las contraseñas. Viven en parametros-argon2.json porque también
 * los usa db/hash-contrasena.js (la semilla del administrador), que no pasa por TypeScript.
 * El JSON no se llama argon2.json a propósito: Jest resuelve `config/argon2` probando .js y
 * .json antes que .ts, y con el mismo nombre importaba el JSON en lugar de este archivo.
 *
 * Son los mínimos que recomienda OWASP (Password Storage Cheat Sheet) para argon2id, pensados
 * para el plan gratuito de Render (512 MB, CPU compartida): unos 30 a 60 ms por hash.
 *
 *   memoryCost  19456 KiB (19 MiB) de memoria por hash: encarece los ataques con GPU.
 *   timeCost    2 pasadas sobre esa memoria.
 *   parallelism 1 hilo: con más, un login ocuparía varios núcleos del servidor.
 *   hashLength  32 bytes de salida. La sal (16 bytes aleatorios) la genera la librería.
 *
 * Si se suben, los hashes viejos siguen verificando (cada hash guarda sus parámetros) y se
 * recalculan con los nuevos en el siguiente login correcto (ver ContrasenaService).
 */
export const PARAMETROS_ARGON2 = {
  memoryCost: entero('memoryCost'),
  timeCost: entero('timeCost'),
  parallelism: entero('parallelism'),
  hashLength: entero('hashLength'),
} as const;

/** Un parámetro ausente haría que argon2 use sus valores por defecto sin avisar: se corta aquí. */
function entero(nombre: keyof typeof parametros): number {
  const valor: unknown = parametros[nombre];
  if (typeof valor !== 'number' || !Number.isInteger(valor) || valor < 1) {
    throw new Error(`parametros-argon2.json: ${nombre} debe ser un entero positivo`);
  }
  return valor;
}
