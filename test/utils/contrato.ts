import Ajv, { ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import * as yaml from 'js-yaml';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Valida un cuerpo contra un esquema de components.schemas de contracts/vuelos-openapi.yaml,
 * con Ajv 8 (que entiende el `nullable` de OpenAPI 3.0) y ajv-formats (date, date-time, uuid).
 * `strict: false` porque el contrato usa palabras propias de OpenAPI como `example`.
 */
const contrato = yaml.load(
  readFileSync(join(__dirname, '..', '..', 'contracts', 'vuelos-openapi.yaml'), 'utf8'),
) as object;
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(contrato, 'contrato');

const cache = new Map<string, ValidateFunction>();

/** Los errores de validación (vacío si cumple), con la ruta del dato que falla. */
export function erroresContraContrato(esquema: string, datos: unknown): string[] {
  let validar = cache.get(esquema);
  if (!validar) {
    validar = ajv.getSchema(`contrato#/components/schemas/${esquema}`);
    if (!validar) throw new Error(`El contrato no tiene el esquema ${esquema}`);
    cache.set(esquema, validar);
  }
  return validar(datos)
    ? []
    : (validar.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`);
}

export interface OperacionContrato {
  /** `GET /bookings/{bookingId}`, como la escribe el contrato. */
  clave: string;
  metodo: string;
  ruta: string;
  /** Códigos que el contrato declara para la operación. */
  codigos: string[];
  /** Scopes de OAuth2Security; [] si es pública. */
  scopes: string[];
  tags: string[];
  parametros: Array<{ nombre: string; en: string; requerido: boolean }>;
}

type Nodo = Record<string, unknown>;

/** Las operaciones de `paths` del contrato, en su orden. */
export function operacionesDelContrato(): OperacionContrato[] {
  const doc = contrato as { paths: Record<string, Record<string, Nodo>>; security?: unknown };
  const operaciones: OperacionContrato[] = [];
  for (const [ruta, item] of Object.entries(doc.paths)) {
    for (const [metodo, op] of Object.entries(item)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(metodo)) continue;
      const seguridad = (op.security ?? doc.security ?? []) as Array<Record<string, string[]>>;
      operaciones.push({
        clave: `${metodo.toUpperCase()} ${ruta}`,
        metodo: metodo.toUpperCase(),
        ruta,
        codigos: Object.keys(op.responses as Nodo),
        scopes: seguridad.flatMap((s) => s.OAuth2Security ?? []),
        tags: (op.tags as string[]) ?? [],
        parametros: ((op.parameters as Nodo[]) ?? []).map((p) => ({
          nombre: p.name as string,
          en: p.in as string,
          requerido: p.required === true,
        })),
      });
    }
  }
  return operaciones;
}

const escapar = (segmento: string) => segmento.replace(/~/g, '~0').replace(/\//g, '~1');

/**
 * El esquema que el contrato declara para esa respuesta (siguiendo un `$ref` a
 * components.responses), como referencia de Ajv; null si la respuesta no declara cuerpo, y
 * undefined si el contrato no declara ese código.
 */
export function esquemaDeRespuesta(
  metodo: string,
  ruta: string,
  codigo: number,
): string | null | undefined {
  const doc = contrato as { paths: Record<string, Record<string, Nodo>>; components: Nodo };
  const respuestas = doc.paths[ruta]?.[metodo.toLowerCase()]?.responses as Nodo | undefined;
  let respuesta = respuestas?.[String(codigo)] as Nodo | undefined;
  if (!respuesta) return undefined;
  let puntero = `#/paths/${escapar(ruta)}/${metodo.toLowerCase()}/responses/${codigo}`;
  if (typeof respuesta.$ref === 'string') {
    puntero = respuesta.$ref;
    const nombre = puntero.split('/').pop() as string;
    respuesta = (doc.components.responses as Nodo)[nombre] as Nodo;
  }
  const contenido = respuesta.content as Record<string, Nodo> | undefined;
  if (!contenido) return null;
  const tipo = Object.keys(contenido)[0];
  return `contrato${puntero}/content/${escapar(tipo)}/schema`;
}

/** Errores de Ajv del cuerpo contra una referencia de `esquemaDeRespuesta`. */
export function erroresContraReferencia(referencia: string, datos: unknown): string[] {
  let validar = cache.get(referencia);
  if (!validar) {
    validar = ajv.getSchema(referencia);
    if (!validar) throw new Error(`El contrato no resuelve ${referencia}`);
    cache.set(referencia, validar);
  }
  return validar(datos)
    ? []
    : (validar.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`);
}

/** El contrato ya cargado (solo lectura), para las pruebas que comparan documentos. */
export function documentoDelContrato(): Nodo {
  return contrato as Nodo;
}
