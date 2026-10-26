import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { desactivarUsuariosDePrueba } from './utils/auth';
import { fechaEn, HUELLA } from './utils/busqueda';
import { operacionesV2, SERVIDOR_V2 } from './utils/contrato-v2';
import { crearApp } from './utils/crear-app';
import { LimitesReiniciables } from './utils/limites';
import { RelojDePrueba } from './utils/reloj';
import { nuevoCliente, pasajero } from './utils/reserva';

/**
 * La fachada v2 con AUTH_MODE=local (el modo por defecto): no hay partners (los tokens del core
 * no traen client_id), así que X-User-Id se ignora siempre; la compra entera funciona igual. Y
 * el Swagger de v2 (/api/v2/docs), aparte del de v1.
 */

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- cuerpos de la API

const V2 = '/api/v2/vuelos';

/** Las operaciones que implementa la fase V1 (las de test/contrato-v2.e2e-spec.ts). */
const IMPLEMENTADAS = new Set([
  'getHealth',
  'searchFlights',
  'getSeatMap',
  'getFlightStatus',
  'createHold',
  'getHold',
  'releaseHold',
  'listBookings',
  'createBooking',
  'getBooking',
  'issueTickets',
  'listTickets',
  'getTicket',
  'checkIn',
  'listBoardingPasses',
  'getBaggageOptions',
  'addBaggage',
  'searchDateChange',
  'confirmDateChange',
  'getCancellationQuote',
  'cancelBooking',
]);

describe('Fachada v2 con AUTH_MODE=local', () => {
  const reloj = new RelojDePrueba();
  const limites = new LimitesReiniciables();
  let app: INestApplication;
  let prisma: PrismaService;
  let cliente: { id: string; token: string };

  const v2 = (metodo: 'get' | 'post' | 'delete', ruta: string, cabeceras: Json = {}) => {
    let prueba = request(app.getHttpServer())
      [metodo](`${V2}${ruta}`)
      .set('Authorization', `Bearer ${cliente.token}`);
    for (const [nombre, valor] of Object.entries(cabeceras)) prueba = prueba.set(nombre, valor);
    return prueba;
  };

  beforeAll(async () => {
    app = await crearApp([], { reloj, limites });
    prisma = app.get(PrismaService);
    cliente = await nuevoCliente(app);
  });
  beforeEach(() => {
    reloj.alPresente();
    limites.reiniciar();
  });
  afterAll(async () => {
    await desactivarUsuariosDePrueba(app);
    await app.close();
  });

  it('search → hold → booking (BOOKING_PROTOTIPO) → tickets → cancel SAGA_COMPENSATION, con un token del core', async () => {
    const busqueda = await v2('post', '/search', { 'X-Device-Fingerprint': HUELLA })
      .send({
        itineraries: [{ origin: 'UIO', destination: 'GYE', departureDate: fechaEn(70) }],
        passengers: { adults: 1 },
      })
      .expect(200);
    const oferta = (busqueda.body.offers as Json[]).find((o) =>
      (o.itineraries as Json[]).every((it) => it.segments.length === 1),
    )!;
    const hold = await v2('post', '/offers/hold', { 'Idempotency-Key': randomUUID() })
      .send({
        offerId: oferta.offerId,
        itinerarySelections: (oferta.itineraries as Json[]).map((it) => ({
          itineraryId: it.itineraryId,
          cabinClass: it.pricingOptions[0].cabinClass,
          fareBrand: it.pricingOptions[0].fareBrand,
        })),
        passengersBreakdown: { adults: 1 },
        ttlMinutes: 10,
      })
      .expect(201);
    expect(hold.body.ttlMinutes).toBe(10);

    const reserva = await v2('post', '/bookings', {
      'Idempotency-Key': randomUUID(),
      // Con AUTH_MODE=local no hay partners: la cabecera no cuenta
      'X-User-Id': 'usr-ignorado',
    })
      .send({
        holdId: hold.body.holdId,
        passengers: [pasajero('ADULT', 7001)],
        payment: { paymentReference: `PAY-BKP-${randomUUID().slice(0, 8).toUpperCase()}` },
      })
      .expect(201);
    expect(reserva.body.status).toBe('CONFIRMED');
    const [fila] = await prisma.db.$queryRaw<Json[]>`
      SELECT id_cliente, id_usuario_externo FROM vuelos.reserva_cabecera
       WHERE id = ${reserva.body.bookingId}::uuid`;
    expect(fila).toEqual({ id_cliente: null, id_usuario_externo: null });

    const emision = await v2('post', `/bookings/${reserva.body.bookingId}/tickets`).expect(200);
    expect(emision.body.issued).toBe(0);
    const cancelada = await v2('post', `/bookings/${reserva.body.bookingId}/cancel`, {
      'Idempotency-Key': randomUUID(),
    })
      .send({ reasonCode: 'SAGA_COMPENSATION' })
      .expect(200);
    expect(cancelada.body).toMatchObject({
      status: 'CANCELLED',
      reasonCode: 'SAGA_COMPENSATION',
      refund: { status: 'CALCULATED', penaltyAmount: '0.00' },
    });
  });

  describe('Swagger de v2 (/api/v2/docs), aparte del de v1', () => {
    let v1: Json;
    let documento: Json;

    beforeAll(async () => {
      documento = (await request(app.getHttpServer()).get('/api/v2/docs-json').expect(200)).body;
      v1 = (await request(app.getHttpServer()).get('/api/docs-json').expect(200)).body;
    });

    it('tiene exactamente las operaciones implementadas, en las rutas y con los operationId del contrato v2', () => {
      const delContrato = operacionesV2()
        .filter((o) => IMPLEMENTADAS.has(o.operationId))
        .map((o) => `${o.metodo} ${SERVIDOR_V2}${o.ruta} ${o.operationId}`)
        .sort();
      const generadas = Object.entries(documento.paths as Json)
        .flatMap(([ruta, item]) =>
          Object.entries(item as Json).map(
            ([metodo, op]) => `${metodo.toUpperCase()} ${ruta} ${(op as Json).operationId}`,
          ),
        )
        .sort();
      expect(generadas).toEqual(delContrato);
      expect(delContrato).toHaveLength(IMPLEMENTADAS.size);
    });

    it('las públicas no piden token; las demás declaran el scope del contrato v2', () => {
      for (const o of operacionesV2().filter((x) => IMPLEMENTADAS.has(x.operationId))) {
        const op = documento.paths[`${SERVIDOR_V2}${o.ruta}`][o.metodo.toLowerCase()];
        const scopes = ((op.security ?? []) as Json[]).flatMap((s) => s.OAuth2Security ?? []);
        expect({ op: o.operationId, scopes }).toEqual({ op: o.operationId, scopes: o.scopes });
      }
    });

    it('el de v1 no tiene ninguna ruta de /api/v2', () => {
      expect(Object.keys(v1.paths).filter((r) => r.startsWith('/api/v2'))).toEqual([]);
    });

    it('cada ruta de /api/v2/vuelos que atiende la app está en el documento de v2', () => {
      const pila = (
        app.getHttpAdapter().getInstance() as {
          _router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> };
        }
      )._router.stack;
      const documentadas = new Set(
        Object.entries(documento.paths as Json).flatMap(([ruta, item]) =>
          Object.keys(item as Json).map(
            (m) => `${m.toUpperCase()} ${ruta.replace(/\{(\w+)\}/g, ':$1')}`,
          ),
        ),
      );
      const rutas = pila
        .filter((capa) => capa.route?.path.startsWith(`${V2}/`))
        .flatMap((capa) =>
          Object.keys(capa.route!.methods).map((m) => `${m.toUpperCase()} ${capa.route!.path}`),
        );
      expect(rutas.length).toBe(IMPLEMENTADAS.size);
      expect(rutas.filter((r) => !documentadas.has(r))).toEqual([]);
    });
  });
});
