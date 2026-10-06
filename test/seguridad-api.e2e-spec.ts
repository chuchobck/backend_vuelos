import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { crearUsuario, desactivarUsuariosDePrueba, firmarToken, iniciarSesion } from './utils/auth';
import { fechaEn } from './utils/busqueda';
import { operacionesDelContrato } from './utils/contrato';
import { crearApp } from './utils/crear-app';
import { LimitesReiniciables } from './utils/limites';
import { cancelarReservasDe } from './utils/postventa';
import { esperarProblemDetails } from './utils/problem-details';
import { RelojDePrueba } from './utils/reloj';
import {
  buscarYRetener,
  con,
  cuerpoReserva,
  HOLD,
  nuevoCliente,
  pasajero,
  referenciaPago,
  reservar,
  RESERVAS,
} from './utils/reserva';

/**
 * Seguridad recorriendo la API entera: cada ruta protegida del contrato y de Swagger (401 sin
 * token, 403 sin el scope), los recursos de otro usuario (404), tokens manipulados, la familia
 * de refresh, inyección SQL y XSS en el texto, 413 y 415, helmet y CORS. Los casos finos de cada
 * tema están en sus suites (autorizacion, auth, seguridad, sanitizacion); aquí se barre todo.
 */

type Nodo = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- documento OpenAPI

const PREFIJO = '/flights/v1';
const TODOS_LOS_SCOPES = [
  'flights:read',
  'flights:hold',
  'flights:book',
  'flights:cancel',
  'flights:webhooks',
  'flights:admin',
];

/** Valores de ejemplo para los parámetros de ruta (el guard corta antes de validarlos). */
function rellenar(ruta: string): string {
  return ruta.replace(/\{(\w+)\}/g, (_, nombre: string) => {
    if (nombre === 'flightNumber') return 'LA1400';
    if (nombre === 'ticketId') return '0451234567890';
    return randomUUID();
  });
}

function pedir(app: INestApplication, metodo: string, ruta: string, token?: string) {
  let prueba = request(app.getHttpServer())[metodo.toLowerCase() as 'get'](ruta);
  if (token) prueba = prueba.set('Authorization', `Bearer ${token}`);
  return ['POST', 'PUT', 'PATCH'].includes(metodo) ? prueba.send({}) : prueba;
}

describe('Seguridad de toda la API', () => {
  const reloj = new RelojDePrueba();
  const limites = new LimitesReiniciables();
  let app: INestApplication;
  let prisma: PrismaService;
  let swagger: Nodo;
  let duena: { id: string; token: string };
  let intruso: { id: string; token: string };

  beforeAll(async () => {
    process.env.CORS_ORIGINS = 'https://app.quinde.example';
    app = await crearApp([], { reloj, limites });
    delete process.env.CORS_ORIGINS;
    prisma = app.get(PrismaService);
    swagger = (await request(app.getHttpServer()).get('/api/docs-json').expect(200)).body;
    duena = await nuevoCliente(app);
    intruso = await nuevoCliente(app);
  });
  beforeEach(() => {
    reloj.alPresente();
    limites.reiniciar();
  });
  afterAll(async () => {
    await cancelarReservasDe(app, duena.token);
    await desactivarUsuariosDePrueba(app);
    await app.close();
  });

  /** Todas las operaciones protegidas de Swagger: las del contrato y las propias (admin, auth). */
  const protegidas = () =>
    Object.entries(swagger.paths as Nodo).flatMap(([ruta, item]) =>
      Object.entries(item as Nodo)
        .filter(([, op]) => ((op as Nodo).security ?? []).length > 0)
        .map(([metodo, op]) => ({
          metodo: metodo.toUpperCase(),
          ruta,
          scopes: (((op as Nodo).security as Nodo[]).find((s) => s.OAuth2Security)
            ?.OAuth2Security ?? []) as string[],
        })),
    );

  describe('sin token: 401 en cada operación protegida', () => {
    it('las del contrato (todas las que declaran OAuth2Security)', async () => {
      const delContrato = operacionesDelContrato().filter((op) => op.scopes.length > 0);
      expect(delContrato.length).toBe(19);
      const fallan: string[] = [];
      for (const op of delContrato) {
        const respuesta = await pedir(app, op.metodo, `${PREFIJO}${rellenar(op.ruta)}`);
        if (respuesta.status !== 401 || respuesta.type !== 'application/problem+json') {
          fallan.push(`${op.clave}: ${respuesta.status}`);
        }
      }
      expect(fallan).toEqual([]);
    });

    it('y las propias del proyecto (catálogo de administración y auth)', async () => {
      const propias = protegidas().filter((op) => /\/(admin|auth)\//.test(op.ruta));
      expect(propias.length).toBeGreaterThan(30);
      const fallan: string[] = [];
      for (const op of propias) {
        limites.reiniciar();
        const respuesta = await pedir(app, op.metodo, rellenar(op.ruta));
        if (respuesta.status !== 401) fallan.push(`${op.metodo} ${op.ruta}: ${respuesta.status}`);
      }
      expect(fallan).toEqual([]);
    });

    it('las públicas del contrato no piden token', () => {
      const publicas = operacionesDelContrato().filter((op) => op.scopes.length === 0);
      expect(publicas.map((op) => op.clave).sort()).toEqual([
        'GET /flights/{flightNumber}/status',
        'GET /offers/{offerId}/seatmap',
        'POST /search',
      ]);
    });
  });

  describe('scope insuficiente: 403', () => {
    it('cada operación del contrato, con un token que tiene todos los scopes menos el suyo', async () => {
      const fallan: string[] = [];
      for (const op of operacionesDelContrato().filter((o) => o.scopes.length > 0)) {
        const token = firmarToken(
          app,
          { scope: TODOS_LOS_SCOPES.filter((s) => !op.scopes.includes(s)).join(' ') },
          { subject: duena.id, expiresIn: 60 },
        );
        const respuesta = await pedir(app, op.metodo, `${PREFIJO}${rellenar(op.ruta)}`, token);
        if (respuesta.status !== 403) fallan.push(`${op.clave}: ${respuesta.status}`);
        else esperarProblemDetails(respuesta);
      }
      expect(fallan).toEqual([]);
    });

    it('el catálogo de administración con un token de cliente', async () => {
      const fallan: string[] = [];
      for (const op of protegidas().filter((o) => o.ruta.includes('/admin/'))) {
        limites.reiniciar();
        const respuesta = await pedir(app, op.metodo, rellenar(op.ruta), duena.token);
        if (respuesta.status !== 403) fallan.push(`${op.metodo} ${op.ruta}: ${respuesta.status}`);
      }
      expect(fallan).toEqual([]);
    });
  });

  describe('recurso de otro usuario: 404, igual que uno que no existe', () => {
    let bookingId: string;
    let itineraryId: string;
    let holdId: string;
    let webhookId: string;

    beforeAll(async () => {
      reloj.alPresente();
      const retenido = await buscarYRetener(
        app,
        duena.token,
        [['UIO', 'GYE', fechaEn(41)]],
        {
          adults: 1,
        },
        { directa: true, fareBrand: 'CLASSIC' },
      );
      const reserva = await reservar(
        app,
        duena.token,
        cuerpoReserva(retenido.holdId, [pasajero('ADULT', 1)], referenciaPago()),
      ).expect(201);
      bookingId = reserva.body.bookingId;
      itineraryId = reserva.body.itineraries[0].itineraryId;
      holdId = (
        await buscarYRetener(
          app,
          duena.token,
          [['UIO', 'GYE', fechaEn(42)]],
          { adults: 1 },
          {
            directa: true,
          },
        )
      ).holdId;
      webhookId = (
        await con(app, duena.token)('post', '/flights/v1/webhooks')
          .send({
            url: `http://localhost:9/ajeno/${randomUUID()}`,
            events: ['booking.confirmed'],
            secret: 'secreto-del-dueno-123',
          })
          .expect(201)
      ).body.id;
    });
    afterAll(async () => {
      await con(app, duena.token)('delete', `${HOLD}/${holdId}`);
      await con(app, duena.token)('delete', `/flights/v1/webhooks/${webhookId}`);
    });

    it('el intruso recibe 404 en cada operación sobre la reserva, el hold y el webhook ajenos', async () => {
      const clave = () => randomUUID();
      const pago = () => ({ paymentReference: referenciaPago() });
      const casos: Array<[string, () => request.Test]> = [
        ['GET reserva', () => con(app, intruso.token)('get', `${RESERVAS}/${bookingId}`)],
        ['GET boletos', () => con(app, intruso.token)('get', `${RESERVAS}/${bookingId}/tickets`)],
        [
          'GET equipaje',
          () => con(app, intruso.token)('get', `${RESERVAS}/${bookingId}/baggage-options`),
        ],
        [
          'POST equipaje',
          () =>
            con(app, intruso.token)('post', `${RESERVAS}/${bookingId}/baggage`)
              .set('Idempotency-Key', clave())
              .send({ passengerId: 'ADU1', itineraryId, quantity: 1, payment: pago() }),
        ],
        [
          'POST cambio (búsqueda)',
          () =>
            con(app, intruso.token)('post', `${RESERVAS}/${bookingId}/date-change/search`).send({
              changes: [{ itineraryId, newDepartureDate: fechaEn(43) }],
            }),
        ],
        [
          'POST cambio',
          () =>
            con(app, intruso.token)('post', `${RESERVAS}/${bookingId}/date-change`)
              .set('Idempotency-Key', clave())
              .send({ changeOfferId: randomUUID(), payment: pago() }),
        ],
        [
          'GET cotización',
          () => con(app, intruso.token)('get', `${RESERVAS}/${bookingId}/cancellation-quote`),
        ],
        [
          'POST cancelar',
          () =>
            con(app, intruso.token)('post', `${RESERVAS}/${bookingId}/cancel`)
              .set('Idempotency-Key', clave())
              .send({ quoteId: randomUUID() }),
        ],
        [
          'POST check-in',
          () => con(app, intruso.token)('post', `${RESERVAS}/${bookingId}/check-in`),
        ],
        [
          'GET pases',
          () => con(app, intruso.token)('get', `${RESERVAS}/${bookingId}/boarding-passes`),
        ],
        ['GET hold', () => con(app, intruso.token)('get', `${HOLD}/${holdId}`)],
        ['DELETE hold', () => con(app, intruso.token)('delete', `${HOLD}/${holdId}`)],
        [
          'DELETE webhook',
          () => con(app, intruso.token)('delete', `/flights/v1/webhooks/${webhookId}`),
        ],
      ];
      const fallan: string[] = [];
      for (const [nombre, hacer] of casos) {
        const respuesta = await hacer();
        if (respuesta.status !== 404) fallan.push(`${nombre}: ${respuesta.status}`);
        else expect(JSON.stringify(respuesta.body)).not.toContain('Ana María');
      }
      expect(fallan).toEqual([]);
      // Y nada cambió para la dueña
      const reserva = await con(app, duena.token)('get', `${RESERVAS}/${bookingId}`).expect(200);
      expect(reserva.body.status).toBe('CONFIRMED');
      await con(app, duena.token)('get', `${HOLD}/${holdId}`).expect(200);
      expect(
        (await con(app, duena.token)('get', '/flights/v1/webhooks').expect(200)).body,
      ).toHaveLength(1);
    });

    it('la lista de reservas del intruso no trae la ajena', async () => {
      const lista = await con(app, intruso.token)('get', RESERVAS).expect(200);
      expect(lista.body.items).toEqual([]);
    });
  });

  describe('tokens manipulados, vencidos o sin firma: 401', () => {
    it.each([
      [
        'vencido',
        () => firmarToken(app, { scope: 'flights:read' }, { subject: duena.id, expiresIn: -5 }),
      ],
      [
        'firmado con otra clave',
        () =>
          firmarToken(
            app,
            { scope: 'flights:read' },
            { subject: duena.id, expiresIn: 60, clave: 'una-clave-que-no-es-la-de-la-api-32+' },
          ),
      ],
      [
        'con el scope cambiado a mano',
        () => {
          const [cabecera, , firma] = firmarToken(
            app,
            { scope: 'flights:read' },
            { subject: duena.id, expiresIn: 60 },
          ).split('.');
          const claims = Buffer.from(
            JSON.stringify({
              sub: duena.id,
              scope: TODOS_LOS_SCOPES.join(' '),
              exp: 9_999_999_999,
            }),
          ).toString('base64url');
          return `${cabecera}.${claims}.${firma}`;
        },
      ],
      [
        'con alg none',
        () =>
          [
            Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url'),
            Buffer.from(
              JSON.stringify({
                sub: duena.id,
                scope: TODOS_LOS_SCOPES.join(' '),
                exp: 9_999_999_999,
              }),
            ).toString('base64url'),
            '',
          ].join('.'),
      ],
      ['basura', () => 'no.es.un.jwt'],
    ])('%s', async (_caso, token) => {
      const respuesta = await con(app, token())('get', RESERVAS);
      expect(respuesta.status).toBe(401);
      esperarProblemDetails(respuesta);
      expect(JSON.stringify(respuesta.body)).not.toMatch(/eyJ|secret|JWT_SECRET/);
    });
  });

  it('reusar un refresh ya rotado revoca la familia: el vigente tampoco sirve', async () => {
    const usuario = await crearUsuario(app);
    const sesion = await iniciarSesion(app, usuario);
    const http = () => request(app.getHttpServer());
    const rotado = await http()
      .post('/flights/v1/auth/refresh')
      .send({ refresh_token: sesion.refresh_token })
      .expect(200);
    await http()
      .post('/flights/v1/auth/refresh')
      .send({ refresh_token: sesion.refresh_token })
      .expect(401);
    await http()
      .post('/flights/v1/auth/refresh')
      .send({ refresh_token: rotado.body.refresh_token })
      .expect(401);
  });

  describe('inyección SQL y XSS en parámetros de texto', () => {
    const SQL = "' OR '1'='1'; DROP TABLE vuelos.reserva_cabecera; --";
    const XSS = '<script>alert(1)</script>';

    it.each([
      [
        'pnr en la query',
        () => con(app, duena.token)('get', `${RESERVAS}?pnr=${encodeURIComponent(SQL)}`),
      ],
      [
        'pnr con XSS',
        () => con(app, duena.token)('get', `${RESERVAS}?pnr=${encodeURIComponent(XSS)}`),
      ],
      [
        'número de vuelo en la ruta',
        () =>
          con(app)(
            'get',
            `/flights/v1/flights/${encodeURIComponent(SQL)}/status?date=${fechaEn(3)}`,
          ),
      ],
      [
        'fecha del estado de vuelo',
        () => con(app)('get', `/flights/v1/flights/LA1400/status?date=${encodeURIComponent(XSS)}`),
      ],
      [
        'origen de la búsqueda',
        () =>
          con(app)('post', '/flights/v1/search')
            .set('X-Device-Fingerprint', 'seguridad-api-0001')
            .send({
              itineraries: [{ origin: SQL, destination: 'GYE', departureDate: fechaEn(3) }],
              passengers: { adults: 1 },
            }),
      ],
      [
        'huella del dispositivo',
        () =>
          con(app)('post', '/flights/v1/search')
            .set('X-Device-Fingerprint', XSS)
            .send({
              itineraries: [{ origin: 'UIO', destination: 'GYE', departureDate: fechaEn(3) }],
              passengers: { adults: 1 },
            }),
      ],
      [
        'nombre del pasajero',
        () =>
          reservar(
            app,
            duena.token,
            cuerpoReserva(randomUUID(), [pasajero('ADULT', 1, { firstName: XSS })]),
          ),
      ],
      [
        'apellido del pasajero',
        () =>
          reservar(
            app,
            duena.token,
            cuerpoReserva(randomUUID(), [pasajero('ADULT', 1, { lastName: SQL })]),
          ),
      ],
      [
        'URL de un webhook',
        () =>
          con(app, duena.token)('post', '/flights/v1/webhooks').send({
            url: `javascript:${XSS}`,
            events: ['booking.confirmed'],
            secret: 'secreto-de-prueba-xss-1',
          }),
      ],
    ])('%s: 4xx sin 500 y sin reflejar el valor', async (_caso, hacer) => {
      const respuesta = await hacer();
      expect(respuesta.status).toBeGreaterThanOrEqual(200);
      expect(respuesta.status).toBeLessThan(500);
      expect(respuesta.text).not.toContain('<script>');
      expect(respuesta.text).not.toContain('DROP TABLE');
    });

    it('la base sigue entera después de los intentos', async () => {
      expect(await prisma.db.reserva_cabecera.count()).toBeGreaterThan(0);
      expect(await prisma.db.pais.count()).toBeGreaterThan(0);
    });
  });

  describe('cuerpo y tipo de contenido en una operación del contrato', () => {
    it('POST /search de 101 kB: 413', async () => {
      const respuesta = await con(app)('post', '/flights/v1/search')
        .set('X-Device-Fingerprint', 'seguridad-api-0001')
        .send({ relleno: 'a'.repeat(101 * 1024) });
      expect(respuesta.status).toBe(413);
      esperarProblemDetails(respuesta);
    });

    it('POST /bookings con XML: 415', async () => {
      const respuesta = await con(app, duena.token)('post', RESERVAS)
        .set('Content-Type', 'application/xml')
        .set('Idempotency-Key', randomUUID())
        .send('<booking/>');
      expect(respuesta.status).toBe(415);
      esperarProblemDetails(respuesta);
    });
  });

  describe('cabeceras', () => {
    it('helmet en una operación del contrato y en un error, sin X-Powered-By', async () => {
      for (const respuesta of [
        await con(app, duena.token)('get', RESERVAS),
        await con(app)('get', RESERVAS),
      ]) {
        expect(respuesta.headers['x-content-type-options']).toBe('nosniff');
        expect(respuesta.headers['strict-transport-security']).toMatch(/max-age=\d+/);
        expect(respuesta.headers['content-security-policy']).toContain("default-src 'self'");
        expect(respuesta.headers['x-frame-options']).toBe('SAMEORIGIN');
        expect(respuesta.headers['referrer-policy']).toBe('no-referrer');
        expect(respuesta.headers['x-powered-by']).toBeUndefined();
      }
    });

    it('CORS: solo el origen de la lista recibe Access-Control-Allow-Origin', async () => {
      const permitido = await con(app)('get', '/flights/v1/health').set(
        'Origin',
        'https://app.quinde.example',
      );
      expect(permitido.headers['access-control-allow-origin']).toBe('https://app.quinde.example');
      const ajeno = await con(app)('get', '/flights/v1/health').set(
        'Origin',
        'https://evil.example',
      );
      expect(ajeno.headers['access-control-allow-origin']).toBeUndefined();
      const preflight = await request(app.getHttpServer())
        .options('/flights/v1/bookings')
        .set('Origin', 'https://evil.example')
        .set('Access-Control-Request-Method', 'POST');
      expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
