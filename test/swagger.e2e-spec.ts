import { INestApplication } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as request from 'supertest';
import { crearApp } from './utils/crear-app';
import {
  documentoDelContrato,
  erroresContraReferencia,
  operacionesDelContrato,
} from './utils/contrato';
import { RelojDePrueba } from './utils/reloj';

/**
 * Swagger contra el contrato: el OpenAPI que genera Nest (/api/docs-json) debe tener las mismas
 * operaciones, etiquetas, scopes y parámetros que contracts/vuelos-openapi.yaml, los mismos
 * campos y obligatorios en el cuerpo de la petición, y los mismos campos en la respuesta exitosa
 * (con al menos los obligatorios del contrato: la API puede prometer más). Las diferencias
 * aceptadas van en DIFERENCIAS_ACEPTADAS con su motivo; cualquier otra hace fallar la prueba.
 */

type Nodo = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- documentos OpenAPI

const PREFIJO = '/flights/v1';

/** Diferencias conocidas entre el Swagger generado y el contrato, con su motivo. */
export const DIFERENCIAS_ACEPTADAS: Array<{ diferencia: string; motivo: string }> = [];

/** Rutas fuera del contrato que la API publica a propósito (documentadas en Swagger). */
const RUTAS_PROPIAS = [
  /^\/flights\/v1\/health$/,
  /^\/flights\/v1\/auth\//,
  /^\/flights\/v1\/admin\//,
];

const METODOS = ['get', 'post', 'put', 'patch', 'delete'];

/** Sigue un $ref local (#/components/...) dentro de su documento. */
function resolver(doc: Nodo, nodo: Nodo | undefined): Nodo | undefined {
  let actual = nodo;
  for (let i = 0; actual?.$ref && i < 10; i++) {
    actual = (actual.$ref as string)
      .slice(2)
      .split('/')
      .reduce((n: Nodo, parte: string) => n?.[parte.replace(/~1/g, '/').replace(/~0/g, '~')], doc);
  }
  if (actual?.allOf?.length === 1) return resolver(doc, actual.allOf[0]);
  return actual;
}

/** Campos y obligatorios de un esquema de objeto (o de los ítems de un arreglo). */
function forma(
  doc: Nodo,
  esquema: Nodo | undefined,
  { sinSoloLectura = false } = {},
): { campos: string[]; obligatorios: string[] } | null {
  let s = resolver(doc, esquema);
  if (s?.type === 'array') s = resolver(doc, s.items);
  if (!s || !s.properties) return null;
  // En una petición, un campo readOnly (el id de WebhookSubscription) no se envía
  const campos = Object.entries(s.properties as Nodo)
    .filter(([, p]) => !(sinSoloLectura && resolver(doc, p as Nodo)?.readOnly))
    .map(([nombre]) => nombre);
  return {
    campos: campos.sort(),
    obligatorios: [...(s.required ?? [])].filter((c: string) => campos.includes(c)).sort(),
  };
}

/**
 * Las respuestas pueden ser más estrictas que el contrato: Swagger puede marcar obligatorio un
 * campo que la API siempre devuelve. Los nombres tienen que ser los mismos y todo obligatorio
 * del contrato tiene que seguir siéndolo.
 */
function respuestaCompatible(
  delContrato: { campos: string[]; obligatorios: string[] },
  deNest: { campos: string[]; obligatorios: string[] } | null,
): boolean {
  return (
    deNest !== null &&
    JSON.stringify(delContrato.campos) === JSON.stringify(deNest.campos) &&
    delContrato.obligatorios.every((c) => deNest.obligatorios.includes(c))
  );
}

function cuerpoDe(doc: Nodo, op: Nodo): Nodo | undefined {
  const contenido = resolver(doc, op.requestBody)?.content;
  return contenido?.['application/json']?.schema;
}

function respuestaDe(doc: Nodo, op: Nodo, codigo: string): Nodo | undefined {
  const contenido = resolver(doc, op.responses?.[codigo])?.content;
  return contenido && (Object.values(contenido)[0] as Nodo)?.schema;
}

function parametrosDe(doc: Nodo, op: Nodo): string[] {
  return (op.parameters ?? [])
    .map((p: Nodo) => resolver(doc, p) as Nodo)
    .map((p: Nodo) => `${p.in}:${p.name.toLowerCase()}${p.required ? '*' : ''}`)
    .sort();
}

function scopesDe(op: Nodo, global: Nodo[] | undefined): string[] | 'publica' {
  const seguridad: Nodo[] = op.security ?? global ?? [];
  const oauth = seguridad.find((s) => 'OAuth2Security' in s);
  if (!oauth || (oauth.OAuth2Security as string[]).length === 0) {
    return seguridad.length === 0 || !oauth ? 'publica' : [];
  }
  return [...oauth.OAuth2Security].sort();
}

/** El ejemplo que Swagger UI arma con los `example` de cada campo (como "Try it out"). */
function ejemploDe(doc: Nodo, esquema: Nodo | undefined, profundidad = 0): unknown {
  const s = resolver(doc, esquema);
  if (!s || profundidad > 8) return undefined;
  if (s.example !== undefined) return s.example;
  if (s.type === 'array') {
    const item = ejemploDe(doc, s.items, profundidad + 1);
    return item === undefined ? [] : [item];
  }
  if (s.properties) {
    const objeto: Nodo = {};
    for (const [nombre, propiedad] of Object.entries(s.properties as Nodo)) {
      const valor = ejemploDe(doc, propiedad as Nodo, profundidad + 1);
      if (valor !== undefined) objeto[nombre] = valor;
    }
    return objeto;
  }
  return s.enum?.[0];
}

/**
 * Ids que solo existen en tiempo de ejecución (salen de la respuesta anterior): un ejemplo fijo
 * no puede traerlos, la guía del README dice de dónde copiarlos.
 */
const IDS_DINAMICOS = ['offerId', 'itineraryId', 'holdId', 'quoteId', 'changeOfferId', 'segmentId'];

/** Todas las diferencias entre el documento generado y el contrato, una por línea. */
export function compararConContrato(generado: Nodo): string[] {
  const contrato = documentoDelContrato() as Nodo;
  const diferencias: string[] = [];
  for (const op of operacionesDelContrato()) {
    const nombre = op.clave;
    const deContrato = contrato.paths[op.ruta][op.metodo.toLowerCase()];
    const deNest = generado.paths[`${PREFIJO}${op.ruta}`]?.[op.metodo.toLowerCase()];
    if (!deNest) {
      diferencias.push(`${nombre}: no está en Swagger`);
      continue;
    }
    if (deContrato.operationId && deContrato.operationId !== deNest.operationId) {
      diferencias.push(
        `${nombre}: operationId ${deNest.operationId} en lugar de ${deContrato.operationId}`,
      );
    }
    const tags = [...(deNest.tags ?? [])].sort().join(',');
    if (tags !== [...op.tags].sort().join(',')) {
      diferencias.push(`${nombre}: tags [${tags}] en lugar de [${op.tags.join(',')}]`);
    }
    const scopesContrato = scopesDe(deContrato, contrato.security);
    const scopesNest = scopesDe(deNest, generado.security);
    if (JSON.stringify(scopesContrato) !== JSON.stringify(scopesNest)) {
      diferencias.push(
        `${nombre}: scopes ${JSON.stringify(scopesNest)} en lugar de ${JSON.stringify(scopesContrato)}`,
      );
    }
    const pc = parametrosDe(contrato, deContrato).join(' ');
    const pn = parametrosDe(generado, deNest).join(' ');
    if (pc !== pn) diferencias.push(`${nombre}: parámetros [${pn}] en lugar de [${pc}]`);

    const cuerpoContrato = forma(contrato, cuerpoDe(contrato, deContrato), {
      sinSoloLectura: true,
    });
    const cuerpoNest = forma(generado, cuerpoDe(generado, deNest));
    if (JSON.stringify(cuerpoContrato) !== JSON.stringify(cuerpoNest)) {
      diferencias.push(
        `${nombre}: cuerpo ${JSON.stringify(cuerpoNest)} en lugar de ${JSON.stringify(cuerpoContrato)}`,
      );
    }
    for (const codigo of Object.keys(deContrato.responses)) {
      if (!codigo.startsWith('2')) continue;
      if (!deNest.responses?.[codigo]) {
        diferencias.push(`${nombre}: no documenta la respuesta ${codigo}`);
        continue;
      }
      const rc = forma(contrato, respuestaDe(contrato, deContrato, codigo));
      const rn = forma(generado, respuestaDe(generado, deNest, codigo));
      if (rc && !respuestaCompatible(rc, rn)) {
        diferencias.push(
          `${nombre} ${codigo}: respuesta ${JSON.stringify(rn)} en lugar de ${JSON.stringify(rc)}`,
        );
      }
    }
  }
  // Lo que Swagger publica y el contrato no tiene: solo las rutas propias del proyecto
  const delContrato = new Set(
    operacionesDelContrato().map((o) => `${o.metodo} ${PREFIJO}${o.ruta}`),
  );
  for (const [ruta, item] of Object.entries(generado.paths as Nodo)) {
    for (const metodo of Object.keys(item).filter((m) => METODOS.includes(m))) {
      const clave = `${metodo.toUpperCase()} ${ruta}`;
      if (!delContrato.has(clave) && !RUTAS_PROPIAS.some((r) => r.test(ruta))) {
        diferencias.push(`${clave}: está en Swagger y no en el contrato`);
      }
    }
  }
  return diferencias;
}

describe('Swagger (/api/docs) contra el contrato', () => {
  let app: INestApplication;
  let generado: Nodo;

  beforeAll(async () => {
    app = await crearApp([], { reloj: new RelojDePrueba() });
    const json = await request(app.getHttpServer()).get('/api/docs-json').expect(200);
    generado = json.body;
  });
  afterAll(async () => {
    await app.close();
  });

  it('/api/docs responde 200 con la interfaz', async () => {
    const respuesta = await request(app.getHttpServer()).get('/api/docs').redirects(1);
    expect(respuesta.status).toBe(200);
    expect(respuesta.text).toContain('swagger-ui');
  });

  it('la versión de Swagger es la de package.json y la descripción nombra el contrato', () => {
    const paquete = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    expect(generado.info.version).toBe(paquete.version);
    expect(generado.info.version).toBe('1.0.0');
    expect(generado.info.description).toContain('v1.5.0.0');
  });

  it('la raíz / redirige a /api/docs (no es un 404)', async () => {
    const respuesta = await request(app.getHttpServer()).get('/');
    expect(respuesta.status).toBe(302);
    expect(respuesta.headers.location).toBe('/api/docs');
  });

  it('sin RENDER_EXTERNAL_URL el documento no fija servers (Swagger UI usa su origen)', () => {
    expect(generado.servers ?? []).toEqual([]);
  });

  it('el documento es OpenAPI 3 con las 7 etiquetas del contrato, en su orden', () => {
    expect(generado.openapi).toMatch(/^3\./);
    const contrato = documentoDelContrato() as Nodo;
    const delContrato = (contrato.tags as Nodo[]).map((t) => t.name);
    const generadas = (generado.tags as Nodo[]).map((t) => t.name);
    expect(generadas.slice(0, delContrato.length)).toEqual(delContrato);
  });

  it('operaciones, etiquetas, scopes, parámetros y cuerpos: solo las diferencias aceptadas', () => {
    const aceptadas = new Set(DIFERENCIAS_ACEPTADAS.map((d) => d.diferencia));
    const nuevas = compararConContrato(generado).filter((d) => !aceptadas.has(d));
    expect(nuevas).toEqual([]);
  });

  it('cada diferencia aceptada sigue existiendo (si se corrige, se quita de la lista)', () => {
    const actuales = new Set(compararConContrato(generado));
    expect(DIFERENCIAS_ACEPTADAS.filter((d) => !actuales.has(d.diferencia))).toEqual([]);
  });

  it('los ejemplos de los cuerpos de Swagger cumplen el esquema del contrato (salvo los ids del flujo)', () => {
    const contrato = documentoDelContrato() as Nodo;
    const invalidos: string[] = [];
    for (const op of operacionesDelContrato()) {
      const deNest = generado.paths[`${PREFIJO}${op.ruta}`][op.metodo.toLowerCase()];
      if (!contrato.paths[op.ruta][op.metodo.toLowerCase()].requestBody) continue;
      const ejemplo = ejemploDe(generado, cuerpoDe(generado, deNest));
      const referencia = `contrato#/paths/${op.ruta.replace(/\//g, '~1')}/${op.metodo.toLowerCase()}/requestBody/content/application~1json/schema`;
      const errores = erroresContraReferencia(referencia, ejemplo).filter(
        (e) => !IDS_DINAMICOS.some((id) => e.includes(`'${id}'`)),
      );
      if (errores.length > 0) invalidos.push(`${op.clave}: ${errores.join('; ')}`);
    }
    expect(invalidos).toEqual([]);
  });

  it('los ejemplos funcionan con la semilla: búsqueda, familia y vuelo del estado', async () => {
    const http = () => request(app.getHttpServer());
    const busqueda = generado.paths[`${PREFIJO}/search`].post;
    const cuerpo = ejemploDe(generado, cuerpoDe(generado, busqueda)) as Nodo;
    const respuesta = await http()
      .post(`${PREFIJO}/search`)
      .set('X-Device-Fingerprint', 'swagger-ejemplo-1b2c3d4e')
      .send(cuerpo)
      .expect(200);
    expect(respuesta.body.offers.length).toBeGreaterThan(0);
    // La familia del ejemplo del hold está entre las que vende la búsqueda
    const hold = generado.paths[`${PREFIJO}/offers/hold`].post;
    const familia = (ejemploDe(generado, cuerpoDe(generado, hold)) as Nodo).itinerarySelections[0]
      .fareBrand;
    const familias = new Set(
      respuesta.body.offers.flatMap((o: Nodo) =>
        o.itineraries.flatMap((i: Nodo) => i.pricingOptions.map((p: Nodo) => p.fareBrand)),
      ),
    );
    expect(familias).toContain(familia);
    // El vuelo del ejemplo del estado existe en la fecha del ejemplo de la búsqueda
    const estado = generado.paths[`${PREFIJO}/flights/{flightNumber}/status`].get;
    const parametro = estado.parameters.find((p: Nodo) => p.name === 'flightNumber');
    const vuelo = parametro.example ?? parametro.schema?.example;
    expect(vuelo).toMatch(/^[A-Z0-9]{2}\d{1,4}$/);
    await http()
      .get(`${PREFIJO}/flights/${vuelo}/status?date=${cuerpo.itineraries[0].departureDate}`)
      .expect(200);
  });

  it('no hay rutas de la API fuera de Swagger (nada interno sin documentar)', () => {
    const router = (
      app.getHttpAdapter().getInstance() as {
        _router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> };
      }
    )._router;
    const documentadas = new Set(
      Object.entries(generado.paths as Nodo).flatMap(([ruta, item]) =>
        Object.keys(item)
          .filter((m) => METODOS.includes(m))
          .map((m) => `${m.toUpperCase()} ${ruta.replace(/\{(\w+)\}/g, ':$1')}`),
      ),
    );
    const sinDocumentar = router.stack
      .filter((capa) => capa.route)
      .flatMap((capa) =>
        Object.keys(capa.route!.methods).map((m) => `${m.toUpperCase()} ${capa.route!.path}`),
      )
      .filter((r) => !documentadas.has(r) && !r.includes('/api/docs') && r !== 'GET /');
    expect(sinDocumentar).toEqual([]);
  });
});
