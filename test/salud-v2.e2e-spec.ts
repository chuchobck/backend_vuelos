import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { erroresContraOperacionV2 } from './utils/contrato-v2';
import { AUDIENCIA, IdentidadFalsa } from './utils/identidad-falsa';
import { IdentityTokenFalso, NotifierFalso } from './utils/notifier-falso';
import { RelojDePrueba } from './utils/reloj';

/**
 * GET /api/v2/vuelos/health (getHealth del contrato v2) con AUTH_MODE=external y
 * WEBHOOKS_MODE=notifier: postgres, identity (su JWKS) y el notifier (su /health) como
 * dependencias. Una dependencia caída o lenta no cuelga la respuesta: sale en menos de 1 s.
 */

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- se valida con Ajv

const SALUD = '/api/v2/vuelos/health';
const reloj = new RelojDePrueba();
const entornoAnterior: Record<string, string | undefined> = {};
let identidad: IdentidadFalsa;
let notifier: NotifierFalso;
let identityToken: IdentityTokenFalso;

beforeAll(async () => {
  identidad = await IdentidadFalsa.iniciar(() => reloj.ahora());
  notifier = await NotifierFalso.crear();
  identityToken = await IdentityTokenFalso.crear();
  const entorno = {
    AUTH_MODE: 'external',
    JWT_ISSUER: identidad.emisor,
    JWT_AUDIENCE: AUDIENCIA,
    WEBHOOKS_MODE: 'notifier',
    NOTIFIER_URL: notifier.url,
    IDENTITY_TOKEN_URL: identityToken.urlToken,
    NOTIFIER_CLIENT_ID: 'core-vuelos',
    NOTIFIER_CLIENT_SECRET: 'secreto-de-prueba-del-core-0001',
    EVENT_RELAY_JOB_ENABLED: 'false',
    NODO_ID: 'NODE_VUE_PRUEBA',
    NOMBRE_PROVEEDOR: 'Quinde Pruebas',
  };
  for (const [nombre, valor] of Object.entries(entorno)) {
    entornoAnterior[nombre] = process.env[nombre];
    process.env[nombre] = valor;
  }
});

afterAll(async () => {
  await identidad.detener();
  await notifier.caer();
  await identityToken.caer();
  for (const [nombre, valor] of Object.entries(entornoAnterior)) {
    if (valor === undefined) delete process.env[nombre];
    else process.env[nombre] = valor;
  }
});

describe('GET /api/v2/vuelos/health', () => {
  let app: INestApplication;
  /** La base de la salud se puede "caer" sin bajar PostgreSQL: el repositorio la consulta. */
  let baseCaida: 'no' | 'error' | 'colgada' = 'no';

  const pedir = async () => {
    const inicio = Date.now();
    const respuesta = await request(app.getHttpServer()).get(SALUD);
    return { respuesta, ms: Date.now() - inicio };
  };
  /** Pasa el caché de 5 s (con el reloj de la prueba). */
  const sinCache = () => reloj.adelantar(0.1);
  const dependencia = (cuerpo: Json, nombre: string) =>
    (cuerpo.dependencias as Json[]).find((d) => d.nombre === nombre);

  beforeAll(async () => {
    const { crearApp } = await import('./utils/crear-app');
    const { SaludV2Repository } =
      await import('../src/modules/vuelos/v2/salud/salud-v2.repository');
    const { PrismaService } = await import('../src/prisma/prisma.service');
    app = await crearApp([], { reloj });
    // La consulta real, salvo cuando la prueba la "cae"
    const repositorio = app.get(SaludV2Repository);
    const original = repositorio.consultarBase.bind(repositorio);
    repositorio.consultarBase = () =>
      baseCaida === 'no'
        ? original()
        : baseCaida === 'error'
          ? Promise.reject(new Error('ECONNREFUSED'))
          : new Promise<void>(() => undefined);
    expect(app.get(PrismaService)).toBeDefined();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    baseCaida = 'no';
    await identidad.reiniciar();
    await notifier.levantar();
    sinCache();
  });

  it('todo arriba: 200 HEALTHY con nodo_id y nombre_proveedor del entorno y sus tres dependencias', async () => {
    const { respuesta, ms } = await pedir();
    expect(respuesta.status).toBe(200);
    expect(erroresContraOperacionV2('getHealth', 200, respuesta.body)).toEqual([]);
    expect(respuesta.body).toMatchObject({
      status: 'HEALTHY',
      nodo_id: 'NODE_VUE_PRUEBA',
      nombre_proveedor: 'Quinde Pruebas',
      vertical: 'VUELOS',
      version: '2.0.0',
      circuit_breaker_estado: 'CLOSED',
    });
    expect((respuesta.body.dependencias as Json[]).map((d) => [d.nombre, d.status])).toEqual([
      ['postgres', 'UP'],
      ['identity', 'UP'],
      ['notifier', 'UP'],
    ]);
    expect(typeof respuesta.body.holds_activos_count).toBe('number');
    expect(typeof respuesta.body.vuelos_programados_hoy).toBe('number');
    expect(ms).toBeLessThan(1000);
  });

  it('identity caído: 200 DEGRADED, con identity DOWN', async () => {
    await identidad.caer();
    const { respuesta } = await pedir();
    expect(respuesta.status).toBe(200);
    expect(erroresContraOperacionV2('getHealth', 200, respuesta.body)).toEqual([]);
    expect(respuesta.body.status).toBe('DEGRADED');
    expect(dependencia(respuesta.body, 'identity')?.status).toBe('DOWN');
    expect(dependencia(respuesta.body, 'postgres')?.status).toBe('UP');
  });

  it('el notifier caído: 200 DEGRADED', async () => {
    await notifier.caer();
    const { respuesta } = await pedir();
    expect(respuesta.status).toBe(200);
    expect(respuesta.body.status).toBe('DEGRADED');
    expect(dependencia(respuesta.body, 'notifier')?.status).toBe('DOWN');
  });

  it('identity que no contesta: igual responde en menos de 1 s (DEGRADED)', async () => {
    identidad.tardar(5000);
    const { respuesta, ms } = await pedir();
    expect(ms).toBeLessThan(1000);
    expect(respuesta.body.status).toBe('DEGRADED');
    expect(dependencia(respuesta.body, 'identity')?.status).toBe('DOWN');
  });

  it('la base caída: 503 DOWN con el mismo cuerpo de salud (no un ProblemDetails)', async () => {
    baseCaida = 'error';
    const { respuesta } = await pedir();
    expect(respuesta.status).toBe(503);
    expect(erroresContraOperacionV2('getHealth', 503, respuesta.body)).toEqual([]);
    expect(respuesta.body).toMatchObject({ status: 'DOWN', circuit_breaker_estado: 'OPEN' });
    expect(respuesta.headers['content-type']).toMatch(/^application\/json/);
  });

  it('la base colgada: 503 DOWN en menos de 1 s', async () => {
    baseCaida = 'colgada';
    const { respuesta, ms } = await pedir();
    expect(ms).toBeLessThan(1000);
    expect(respuesta.status).toBe(503);
    expect(dependencia(respuesta.body, 'postgres')?.status).toBe('DOWN');
  });

  it('el resultado se reusa 5 s (reloj de la prueba) y después se vuelve a medir', async () => {
    const primera = (await pedir()).respuesta.body;
    await identidad.caer();
    reloj.adelantar(4 / 60);
    const enCache = (await pedir()).respuesta.body;
    expect(enCache).toEqual(primera);
    reloj.adelantar(2 / 60);
    const nueva = (await pedir()).respuesta.body;
    expect(nueva.status).toBe('DEGRADED');
    expect(nueva.timestamp).not.toBe(primera.timestamp);
  });

  it('es pública y no la corta el límite de peticiones', async () => {
    for (let i = 0; i < 5; i++) expect((await pedir()).respuesta.status).toBe(200);
  });
});
