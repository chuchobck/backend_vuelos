import Ajv, { ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import * as yaml from 'js-yaml';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Como test/utils/contrato.ts, contra contracts/vuelos-openapi-v2.yaml: valida un cuerpo con el
 * esquema que el contrato v2 declara para la respuesta de una operación (Ajv 8 + ajv-formats).
 * Las rutas del contrato v2 son relativas a su server (/api/v2): `/vuelos/bookings`.
 */
const contrato = yaml.load(
  readFileSync(join(__dirname, '..', '..', 'contracts', 'vuelos-openapi-v2.yaml'), 'utf8'),
) as Nodo;
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(contrato, 'contratoV2');

type Nodo = Record<string, unknown>;

/** Prefijo del server del contrato v2: `/vuelos/search` se sirve en `/api/v2/vuelos/search`. */
export const SERVIDOR_V2 = '/api/v2';

const cache = new Map<string, ValidateFunction>();
const escapar = (segmento: string) => segmento.replace(/~/g, '~0').replace(/\//g, '~1');

export interface OperacionV2 {
  operationId: string;
  metodo: string;
  /** Como la escribe el contrato: `/vuelos/bookings/{bookingId}`. */
  ruta: string;
  codigos: string[];
  /** Scopes de PartnerOAuth2; [] si es pública. */
  scopes: string[];
  microservicio: string;
}

/** Las operaciones de `paths` del contrato v2, en su orden. */
export function operacionesV2(): OperacionV2[] {
  const paths = contrato.paths as Record<string, Record<string, Nodo>>;
  const operaciones: OperacionV2[] = [];
  for (const [ruta, item] of Object.entries(paths)) {
    for (const [metodo, op] of Object.entries(item)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(metodo)) continue;
      const seguridad = (op.security ?? contrato.security ?? []) as Array<Record<string, string[]>>;
      operaciones.push({
        operationId: op.operationId as string,
        metodo: metodo.toUpperCase(),
        ruta,
        codigos: Object.keys(op.responses as Nodo),
        scopes: seguridad.flatMap((s) => s.PartnerOAuth2 ?? s.BearerAuth ?? []),
        microservicio: op['x-microservice'] as string,
      });
    }
  }
  return operaciones;
}

/** La operación con ese operationId. */
export function operacionV2(operationId: string): OperacionV2 {
  const op = operacionesV2().find((o) => o.operationId === operationId);
  if (!op) throw new Error(`El contrato v2 no tiene la operación ${operationId}`);
  return op;
}

/**
 * La referencia de Ajv al esquema que el contrato v2 declara para ese código de esa operación;
 * null si la respuesta no tiene cuerpo, undefined si el contrato no declara el código.
 */
export function esquemaDeRespuestaV2(
  operationId: string,
  codigo: number,
): string | null | undefined {
  const op = operacionV2(operationId);
  const paths = contrato.paths as Record<string, Record<string, Nodo>>;
  const respuestas = paths[op.ruta][op.metodo.toLowerCase()].responses as Nodo;
  let respuesta = respuestas[String(codigo)] as Nodo | undefined;
  if (!respuesta) return undefined;
  let puntero = `#/paths/${escapar(op.ruta)}/${op.metodo.toLowerCase()}/responses/${codigo}`;
  if (typeof respuesta.$ref === 'string') {
    puntero = respuesta.$ref;
    const nombre = puntero.split('/').pop() as string;
    respuesta = ((contrato.components as Nodo).responses as Nodo)[nombre] as Nodo;
  }
  const contenido = respuesta.content as Record<string, Nodo> | undefined;
  if (!contenido) return null;
  return `contratoV2${puntero}/content/${escapar(Object.keys(contenido)[0])}/schema`;
}

function validador(referencia: string): ValidateFunction {
  let validar = cache.get(referencia);
  if (!validar) {
    validar = ajv.getSchema(referencia);
    if (!validar) throw new Error(`El contrato v2 no resuelve ${referencia}`);
    cache.set(referencia, validar);
  }
  return validar;
}

/**
 * Los errores del cuerpo contra la respuesta declarada (vacío si cumple). Un código que el
 * contrato no declara para la operación es un error en sí.
 */
export function erroresContraOperacionV2(
  operationId: string,
  codigo: number,
  cuerpo: unknown,
): string[] {
  const referencia = esquemaDeRespuestaV2(operationId, codigo);
  if (referencia === undefined) return [`${operationId} no declara la respuesta ${codigo}`];
  if (referencia === null) return [];
  const validar = validador(referencia);
  return validar(cuerpo)
    ? []
    : (validar.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`);
}

/** Errores contra un esquema de components.schemas del contrato v2. */
export function erroresContraEsquemaV2(esquema: string, datos: unknown): string[] {
  const validar = validador(`contratoV2#/components/schemas/${esquema}`);
  return validar(datos)
    ? []
    : (validar.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`);
}

/** El contrato v2 ya cargado (solo lectura). */
export function documentoV2(): Nodo {
  return contrato;
}
