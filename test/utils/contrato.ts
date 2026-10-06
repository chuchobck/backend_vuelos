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
