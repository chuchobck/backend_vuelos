import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import type {
  CobroEsperado,
  EstadoPago,
  EstadoReembolso,
  ReembolsoPedido,
} from '../src/modules/vuelos/compartido/pagos/servicio-pagos';
import type { PrismaService } from '../src/prisma/prisma.service';
import { erroresContraEsquemaV2, erroresContraOperacionV2, operacionV2 } from './utils/contrato-v2';
import { AUDIENCIA, IdentidadFalsa } from './utils/identidad-falsa';
import { LimitesReiniciables } from './utils/limites';
import { IdentityTokenFalso, NotifierFalso } from './utils/notifier-falso';
import { RelojDePrueba } from './utils/reloj';

/**
 * Pruebas de proveedor del contrato v2 (contracts/vuelos-openapi-v2.yaml) en /api/v2/vuelos:
 * cada operación implementada, en su camino feliz y con sus errores principales, con el cuerpo
 * validado contra el esquema que el contrato declara para ese status (Ajv). Al final, la tabla
 * de cobertura por operationId.
 *
 * Corre con AUTH_MODE=external (tokens RS256 de IdentidadFalsa: personas y partners con
 * client_id) y WEBHOOKS_MODE=notifier (para ver el X-Correlation-Id en evento_saliente y en la
 * publicación al notifier). Las variables se fijan antes de importar AppModule (beforeAll).
 */

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- se valida con Ajv

const V2 = '/api/v2/vuelos';
const HUELLA = 'fp-contrato-v2-01';
const SCOPES = 'flights:read flights:hold flights:book flights:cancel';
const HORA = 3_600_000;
/** Secuencias de color ANSI de los logs de Nest (ESC = código 27). */
const COLORES_ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** Las operaciones del contrato v2 que implementa esta fase. */
const IMPLEMENTADAS = [
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
] as const;
type Operacion = (typeof IMPLEMENTADAS)[number];

/** operationId → status probados (para la tabla de cobertura). */
const cobertura = new Map<Operacion, Set<number>>(IMPLEMENTADAS.map((o) => [o, new Set()]));

/** El cuerpo cumple lo que el contrato v2 declara para ese status de esa operación. */
function esperarV2(operacion: Operacion, respuesta: request.Response, status: number): Json {
  expect({ status: respuesta.status, cuerpo: respuesta.body }).toMatchObject({ status });
  expect(erroresContraOperacionV2(operacion, status, respuesta.body)).toEqual([]);
  cobertura.get(operacion)!.add(status);
  return respuesta.body as Json;
}

/** Un error v2: el status, el code y el ProblemDetails v2 exacto (additionalProperties: false). */
function esperarProblemaV2(
  operacion: Operacion,
  respuesta: request.Response,
  status: number,
  code: string,
): Json {
  const cuerpo = esperarV2(operacion, respuesta, status);
  expect(respuesta.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(cuerpo.code).toBe(code);
  expect(erroresContraEsquemaV2('ProblemDetails', cuerpo)).toEqual([]);
  expect(cuerpo.correlation_id).toBe(respuesta.headers['x-correlation-id']);
  const pedida = (respuesta as unknown as { req: { path: string } }).req.path;
  expect(cuerpo.instance).toBe(new URL(pedida, 'http://x').pathname);
  expect(new Date(cuerpo.timestamp).toString()).not.toBe('Invalid Date');
  return cuerpo;
}

/** La Payment API simulada, con registro de cada llamada (para ver que BOOKING_PROTOTIPO no cobra). */
class PagosEspia {
  autorizaciones: CobroEsperado[] = [];
  consultas: string[] = [];
  reembolsos: ReembolsoPedido[] = [];
  private readonly simulados: {
    autorizar(c: CobroEsperado): Promise<EstadoPago>;
    consultar(r: string): Promise<Exclude<EstadoPago, 'INVALIDO'>>;
    reembolsar(r: ReembolsoPedido): Promise<EstadoReembolso>;
    consultarReembolso(r: ReembolsoPedido): Promise<EstadoReembolso>;
  };
  constructor(simulados: PagosEspia['simulados']) {
    this.simulados = simulados;
  }
  autorizar(cobro: CobroEsperado) {
    this.autorizaciones.push(cobro);
    return this.simulados.autorizar(cobro);
  }
  consultar(referencia: string) {
    this.consultas.push(referencia);
    // Un pago pendiente se aprueba al consultarlo de nuevo (como PagosSimulados)
    return this.simulados.consultar(referencia);
  }
  reembolsar(reembolso: ReembolsoPedido) {
    this.reembolsos.push(reembolso);
    return this.simulados.reembolsar(reembolso);
  }
  consultarReembolso(reembolso: ReembolsoPedido) {
    return this.simulados.consultarReembolso(reembolso);
  }
}

const reloj = new RelojDePrueba();
const limites = new LimitesReiniciables();
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
    RATE_LIMIT_MAX: '100000',
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

describe('Contrato v2 (/api/v2/vuelos): pruebas de proveedor', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let pagos: PagosEspia;
  let u: typeof import('./utils/reserva') & typeof import('./utils/busqueda');

  /** Un partner (client_credentials, con client_id) y una persona, cada uno con su sub. */
  const partner = { sub: randomUUID(), clientId: 'booking-prototipo' };
  const otroPartner = { sub: randomUUID(), clientId: 'otro-partner' };
  const persona = { sub: randomUUID() };
  const tokenPartner = (p = partner, scope = SCOPES) =>
    identidad.firmarCliente(p.clientId, scope, { sub: p.sub });
  const tokenPersona = (scope = SCOPES) => identidad.firmar({ sub: persona.sub, scope });

  const http = () => request(app.getHttpServer());
  const v2 = (
    metodo: 'get' | 'post' | 'delete',
    ruta: string,
    token?: string,
    cabeceras: Record<string, string> = {},
  ) => {
    let prueba = http()[metodo](`${V2}${ruta}`);
    if (token) prueba = prueba.set('Authorization', `Bearer ${token}`);
    for (const [nombre, valor] of Object.entries(cabeceras)) prueba = prueba.set(nombre, valor);
    return prueba;
  };
  const referenciaBooking = () =>
    `PAY-BKP-${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`;

  /** Una oferta directa UIO-GYE de la semilla en `dias` días. */
  const buscar = async (dias: number, pasajeros: Json = { adults: 1 }): Promise<Json> => {
    const respuesta = await v2('post', '/search', undefined, { 'X-Device-Fingerprint': HUELLA })
      .send({
        itineraries: [{ origin: 'UIO', destination: 'GYE', departureDate: u.fechaEn(dias) }],
        passengers: pasajeros,
      })
      .expect(200);
    const oferta = (respuesta.body.offers as Json[]).find((o) =>
      (o.itineraries as Json[]).every((it) => it.segments.length === 1),
    );
    if (!oferta) throw new Error('La búsqueda no devolvió una oferta directa');
    return oferta;
  };
  const cuerpoHold = (oferta: Json, pasajeros: Json = { adults: 1 }, extra: Json = {}) => ({
    offerId: oferta.offerId,
    itinerarySelections: (oferta.itineraries as Json[]).map((it) => ({
      itineraryId: it.itineraryId,
      cabinClass: it.pricingOptions[0].cabinClass,
      fareBrand: it.pricingOptions[0].fareBrand,
    })),
    passengersBreakdown: pasajeros,
    ...extra,
  });
  const retener = async (token: string, dias: number, extra: Json = {}): Promise<Json> => {
    const oferta = await buscar(dias);
    const respuesta = await v2('post', '/offers/hold', token, { 'Idempotency-Key': randomUUID() })
      .send(cuerpoHold(oferta, { adults: 1 }, extra))
      .expect(201);
    return { ...respuesta.body, oferta };
  };
  let serie = 0;
  const cuerpoReserva = (holdId: string, payment: Json, extra: Json = {}) => ({
    holdId,
    passengers: [u.pasajero('ADULT', 500 + ++serie)],
    payment,
    ...extra,
  });
  /** search → hold → booking con el pago de Booking; devuelve la reserva (201). */
  const comprar = async (
    token: string,
    dias: number,
    cabeceras: Record<string, string> = {},
    payment: Json = { paymentReference: referenciaBooking() },
  ): Promise<Json> => {
    const hold = await retener(token, dias);
    const respuesta = await v2('post', '/bookings', token, {
      'Idempotency-Key': randomUUID(),
      ...cabeceras,
    }).send(cuerpoReserva(hold.holdId, payment));
    expect(respuesta.status).toBe(201);
    return respuesta.body;
  };

  /** Como `comprar`, con la primera opción de precio que cumple esa regla de tarifa. */
  const comprarConRegla = async (
    token: string,
    dias: number,
    regla: 'isRefundable' | 'isChangeable',
  ): Promise<Json> => {
    const oferta = await buscar(dias);
    const itinerario = oferta.itineraries[0];
    const opcion = (itinerario.pricingOptions as Json[]).find((p) => p.fareRules[regla]);
    if (!opcion) throw new Error(`La oferta no tiene una tarifa con ${regla}`);
    const hold = await v2('post', '/offers/hold', token, { 'Idempotency-Key': randomUUID() })
      .send({
        offerId: oferta.offerId,
        itinerarySelections: [
          {
            itineraryId: itinerario.itineraryId,
            cabinClass: opcion.cabinClass,
            fareBrand: opcion.fareBrand,
          },
        ],
        passengersBreakdown: { adults: 1 },
      })
      .expect(201);
    return (
      await v2('post', '/bookings', token, { 'Idempotency-Key': randomUUID() })
        .send(cuerpoReserva(hold.body.holdId, { paymentReference: referenciaBooking() }))
        .expect(201)
    ).body as Json;
  };

  beforeAll(async () => {
    u = { ...(await import('./utils/reserva')), ...(await import('./utils/busqueda')) };
    const { crearApp } = await import('./utils/crear-app');
    const { PagosSimulados } =
      await import('../src/modules/vuelos/compartido/pagos/pagos-simulados');
    const { SERVICIO_PAGOS } =
      await import('../src/modules/vuelos/compartido/pagos/servicio-pagos');
    const { PrismaService } = await import('../src/prisma/prisma.service');
    pagos = new PagosEspia(new PagosSimulados());
    app = await crearApp([], {
      reloj,
      limites,
      reemplazos: [{ proveedor: SERVICIO_PAGOS, valor: pagos }],
    });
    prisma = app.get(PrismaService);
  });
  beforeEach(() => {
    reloj.alPresente();
    limites.reiniciar();
  });
  afterAll(async () => {
    // Las reservas de la prueba se cancelan (devuelven su cupo); nada se borra
    for (const dueno of [partner, otroPartner, persona]) {
      const filas = await prisma.db.$queryRaw<Array<{ id: string }>>`
        SELECT rc.id::text AS id FROM vuelos.reserva_cabecera rc
          JOIN vuelos.retencion_cabecera r ON r.id = rc.retencion_id
         WHERE r.id_propietario = ${dueno.sub} AND rc.estado::text = 'CONFIRMADA'`;
      const token = 'clientId' in dueno ? tokenPartner(dueno as typeof partner) : tokenPersona();
      for (const { id } of filas) {
        await v2('post', `/bookings/${id}/cancel`, token, { 'Idempotency-Key': randomUUID() })
          .send({ reasonCode: 'SAGA_COMPENSATION' })
          .catch(() => undefined);
      }
    }
    await app.close();

    // La tabla de cobertura por operationId (también va a docs/V2-DIFERENCIAS.md)
    const filas = IMPLEMENTADAS.map((op) => {
      const { metodo, ruta } = operacionV2(op);
      const probados = [...cobertura.get(op)!].sort().join(', ');
      return `| ${op} | ${metodo} ${ruta} | ${probados} |`;
    });
    process.stdout.write(
      `${['| operationId | ruta | status probados |', '| --- | --- | --- |', ...filas].join('\n')}\n`,
    );
  });

  describe('MS.Vuelos (públicas)', () => {
    it('getHealth: VuelosHealthResponse exacto, sin token', async () => {
      const cuerpo = esperarV2('getHealth', await v2('get', '/health'), 200);
      expect(cuerpo).toMatchObject({ vertical: 'VUELOS', nodo_id: 'NODE_VUE_QUINDE' });
      expect(Object.keys(cuerpo).every((k) => /^[a-z_]+$/.test(k))).toBe(true);
    });

    it('searchFlights: 200 sin token; sin X-Device-Fingerprint, 400 VALIDATION_FAILED', async () => {
      const ida = { origin: 'UIO', destination: 'GYE', departureDate: u.fechaEn(40) };
      esperarV2(
        'searchFlights',
        await v2('post', '/search', undefined, { 'X-Device-Fingerprint': HUELLA }).send({
          itineraries: [ida],
          passengers: { adults: 1 },
        }),
        200,
      );
      esperarProblemaV2(
        'searchFlights',
        await v2('post', '/search').send({ itineraries: [ida], passengers: { adults: 1 } }),
        400,
        'VALIDATION_FAILED',
      );
    });

    it('getSeatMap: status por asiento (BOOKED y TICKETED tras una compra); 404 NOT_FOUND', async () => {
      const reserva = await comprar(tokenPartner(), 41);
      const oferta = await buscar(41);
      const segmento = oferta.itineraries[0].segments[0].segmentId as string;
      const mapa = esperarV2(
        'getSeatMap',
        await v2('get', `/offers/${oferta.offerId}/seatmap?segmentId=${segmento}`),
        200,
      );
      const asientos = (mapa.cabins as Json[]).flatMap((c) =>
        (c.rows as Json[]).flatMap((f) => f.seats as Json[]),
      );
      const asignado = reserva.passengers[0].assignedSeats[0].seatNumber;
      expect(asientos.find((a) => a.seatNumber === asignado)).toMatchObject({
        isAvailable: false,
        status: 'TICKETED',
      });
      expect(asientos.some((a) => a.isAvailable && a.status === 'AVAILABLE')).toBe(true);
      // isAvailable es el atajo de v1: status AVAILABLE si y solo si isAvailable
      for (const a of asientos.filter((x) => x.status !== undefined)) {
        expect(a.isAvailable).toBe(a.status === 'AVAILABLE');
      }
      esperarProblemaV2(
        'getSeatMap',
        await v2('get', `/offers/${randomUUID()}/seatmap?segmentId=${randomUUID()}`),
        404,
        'NOT_FOUND',
      );
    });

    it('getFlightStatus: 200 de un vuelo de la semilla; 404 NOT_FOUND de uno que no existe', async () => {
      const oferta = await buscar(42);
      const segmento = oferta.itineraries[0].segments[0];
      esperarV2(
        'getFlightStatus',
        await v2('get', `/flights/${segmento.flightNumber}/status?date=${u.fechaEn(42)}`),
        200,
      );
      esperarProblemaV2(
        'getFlightStatus',
        await v2('get', `/flights/ZZ9999/status?date=${u.fechaEn(42)}`),
        404,
        'NOT_FOUND',
      );
    });
  });

  describe('MS.Reservas: hold', () => {
    it('createHold: 201 con ttlMinutes y _links; Location; ttlMinutes fuera de 5..30 es 400', async () => {
      const oferta = await buscar(43);
      const respuesta = await v2('post', '/offers/hold', tokenPartner(), {
        'Idempotency-Key': randomUUID(),
      }).send(cuerpoHold(oferta, { adults: 1 }, { ttlMinutes: 7 }));
      const hold = esperarV2('createHold', respuesta, 201);
      expect(hold.ttlMinutes).toBe(7);
      expect(new Date(hold.expiresAt).getTime() - reloj.ahora().getTime()).toBeLessThanOrEqual(
        7 * 60_000 + 1000,
      );
      expect(respuesta.headers.location).toBe(`${V2}/offers/hold/${hold.holdId}`);
      expect(hold._links.release).toEqual({
        href: `${V2}/offers/hold/${hold.holdId}`,
        method: 'DELETE',
      });

      for (const ttlMinutes of [4, 31]) {
        esperarProblemaV2(
          'createHold',
          await v2('post', '/offers/hold', tokenPartner(), {
            'Idempotency-Key': randomUUID(),
          }).send(cuerpoHold(oferta, { adults: 1 }, { ttlMinutes })),
          400,
          'VALIDATION_FAILED',
        );
      }
    });

    it('createHold: sin token 401 UNAUTHORIZED; sin el scope 403 FORBIDDEN; sin clave 400', async () => {
      const oferta = await buscar(43);
      esperarProblemaV2(
        'createHold',
        await v2('post', '/offers/hold', undefined, { 'Idempotency-Key': randomUUID() }).send(
          cuerpoHold(oferta),
        ),
        401,
        'UNAUTHORIZED',
      );
      const sinScope = await v2('post', '/offers/hold', tokenPartner(partner, 'flights:read'), {
        'Idempotency-Key': randomUUID(),
      }).send(cuerpoHold(oferta));
      expect(sinScope.status).toBe(403);
      expect(sinScope.body.code).toBe('FORBIDDEN');
      expect(erroresContraEsquemaV2('ProblemDetails', sinScope.body)).toEqual([]);
      esperarProblemaV2(
        'createHold',
        await v2('post', '/offers/hold', tokenPartner()).send(cuerpoHold(oferta)),
        400,
        'VALIDATION_FAILED',
      );
    });

    it('getHold: 200 con holdId y _links; 404 NOT_FOUND del hold de otro partner', async () => {
      const hold = await retener(tokenPartner(), 44);
      const estado = esperarV2(
        'getHold',
        await v2('get', `/offers/hold/${hold.holdId}`, tokenPartner()),
        200,
      );
      expect(estado).toMatchObject({ holdId: hold.holdId, status: 'HELD' });
      esperarProblemaV2(
        'getHold',
        await v2('get', `/offers/hold/${hold.holdId}`, tokenPartner(otroPartner)),
        404,
        'NOT_FOUND',
      );
    });

    it('releaseHold: 204 y otra vez 204 (compensación idempotente); 404 de otro partner', async () => {
      const hold = await retener(tokenPartner(), 44);
      esperarV2(
        'releaseHold',
        await v2('delete', `/offers/hold/${hold.holdId}`, tokenPartner()),
        204,
      );
      esperarV2(
        'releaseHold',
        await v2('delete', `/offers/hold/${hold.holdId}`, tokenPartner()),
        204,
      );
      esperarProblemaV2(
        'releaseHold',
        await v2('delete', `/offers/hold/${hold.holdId}`, tokenPartner(otroPartner)),
        404,
        'NOT_FOUND',
      );
    });

    it('releaseHold de un hold ya reservado: 409 HOLD_ALREADY_CONSUMED', async () => {
      const reserva = await comprar(tokenPartner(), 45);
      esperarProblemaV2(
        'releaseHold',
        await v2('delete', `/offers/hold/${reserva.holdId}`, tokenPartner()),
        409,
        'HOLD_ALREADY_CONSUMED',
      );
    });
  });

  describe('MS.Reservas: reservas, pagos de Booking y partner', () => {
    it('createBooking (BOOKING_PROTOTIPO): 201 CONFIRMED con boletos, sin llamar a la Payment API', async () => {
      const hold = await retener(tokenPartner(), 46);
      const referencia = referenciaBooking();
      const antes = pagos.autorizaciones.length;
      const respuesta = await v2('post', '/bookings', tokenPartner(), {
        'Idempotency-Key': randomUUID(),
        'X-User-Id': 'usr-booking-1',
      }).send(
        cuerpoReserva(
          hold.holdId,
          { paymentReference: referencia, amount: hold.lockedPrice },
          {
            salesChannel: {
              partnerId: 'BOOKING_PROTOTIPO',
              partnerOrderId: 'ORD-BKP-55120',
              packageId: 'PKG-UIO-GYE-0091',
              promotionApplied: true,
              discountPercentage: 10,
            },
          },
        ),
      );
      const reserva = esperarV2('createBooking', respuesta, 201);
      expect(reserva).toMatchObject({
        status: 'CONFIRMED',
        holdId: hold.holdId,
        paymentReference: referencia,
        salesChannel: {
          partnerId: 'BOOKING_PROTOTIPO',
          partnerOrderId: 'ORD-BKP-55120',
          packageId: 'PKG-UIO-GYE-0091',
          promotionApplied: true,
          discountPercentage: 10,
        },
      });
      expect(reserva.tickets).toHaveLength(1);
      expect(reserva.tickets[0].status).toBe('ISSUED');
      expect(respuesta.headers.location).toBe(`${V2}/bookings/${reserva.bookingId}`);
      expect(reserva._links.self.href).toBe(`${V2}/bookings/${reserva.bookingId}`);
      // La aerolínea no cobra: ni una llamada a la Payment API
      expect(pagos.autorizaciones.length).toBe(antes);
      const [guardada] = await prisma.db.$queryRaw<Json[]>`
        SELECT rc.id_cliente, rc.id_usuario_externo, p.proveedor::text AS proveedor
          FROM vuelos.reserva_cabecera rc
          JOIN vuelos.reserva_detalle_pago p ON p.reserva_id = rc.id AND p.concepto = 'EMISION'
         WHERE rc.id = ${reserva.bookingId}::uuid`;
      expect(guardada).toEqual({
        id_cliente: 'booking-prototipo',
        id_usuario_externo: 'usr-booking-1',
        proveedor: 'BOOKING_PROTOTIPO',
      });
    });

    it('createBooking: la referencia ya usada por otra reserva es 422 PAYMENT_REFERENCE_INVALID', async () => {
      const referencia = referenciaBooking();
      await comprar(tokenPartner(), 47, {}, { paymentReference: referencia });
      const hold = await retener(tokenPartner(), 47);
      esperarProblemaV2(
        'createBooking',
        await v2('post', '/bookings', tokenPartner(), { 'Idempotency-Key': randomUUID() }).send(
          cuerpoReserva(hold.holdId, { paymentReference: referencia }),
        ),
        422,
        'PAYMENT_REFERENCE_INVALID',
      );
      // El hold sigue retenido: la reserva no se hizo
      const estado = await v2('get', `/offers/hold/${hold.holdId}`, tokenPartner());
      expect(estado.body.status).toBe('HELD');
    });

    it('createBooking: un amount distinto del congelado es 422 AMOUNT_MISMATCH', async () => {
      const hold = await retener(tokenPartner(), 48);
      const otro = { ...hold.lockedPrice, total: '1.00' };
      esperarProblemaV2(
        'createBooking',
        await v2('post', '/bookings', tokenPartner(), { 'Idempotency-Key': randomUUID() }).send(
          cuerpoReserva(hold.holdId, { paymentReference: referenciaBooking(), amount: otro }),
        ),
        422,
        'AMOUNT_MISMATCH',
      );
      esperarProblemaV2(
        'createBooking',
        await v2('post', '/bookings', tokenPartner(), { 'Idempotency-Key': randomUUID() }).send(
          cuerpoReserva(hold.holdId, {
            paymentReference: referenciaBooking(),
            amount: { ...hold.lockedPrice, currency: 'EUR' },
          }),
        ),
        422,
        'AMOUNT_MISMATCH',
      );
    });

    it('createBooking: AIRLINE_DIRECT sí pasa por la Payment API (PAY-PEND: 202 PENDING_PAYMENT)', async () => {
      const hold = await retener(tokenPartner(), 49);
      const antes = pagos.autorizaciones.length;
      const reserva = esperarV2(
        'createBooking',
        await v2('post', '/bookings', tokenPartner(), { 'Idempotency-Key': randomUUID() }).send(
          cuerpoReserva(hold.holdId, {
            paymentReference: u.referenciaPago('PEND'),
            provider: 'AIRLINE_DIRECT',
          }),
        ),
        202,
      );
      expect(reserva.status).toBe('PENDING_PAYMENT');
      expect(pagos.autorizaciones.length).toBe(antes + 1);
      expect(reserva._links['issue-tickets']).toEqual({
        href: `${V2}/bookings/${reserva.bookingId}/tickets`,
        method: 'POST',
      });

      // issueTickets pregunta a la Payment API (ahora aprobado) y emite
      const emision = esperarV2(
        'issueTickets',
        await v2('post', `/bookings/${reserva.bookingId}/tickets`, tokenPartner()),
        200,
      );
      expect(emision).toMatchObject({ status: 'CONFIRMED', issued: 1 });
      // Y otra vez: ya estaban emitidos
      const otra = esperarV2(
        'issueTickets',
        await v2('post', `/bookings/${reserva.bookingId}/tickets`, tokenPartner()),
        200,
      );
      expect(otra).toMatchObject({ status: 'CONFIRMED', issued: 0 });
    });

    it('createBooking: hold vencido 410 HOLD_EXPIRED; hold ya reservado 409 HOLD_ALREADY_CONSUMED', async () => {
      const hold = await retener(tokenPartner(), 50, { ttlMinutes: 5 });
      reloj.adelantar(6);
      esperarProblemaV2(
        'createBooking',
        await v2('post', '/bookings', tokenPartner(), { 'Idempotency-Key': randomUUID() }).send(
          cuerpoReserva(hold.holdId, { paymentReference: referenciaBooking() }),
        ),
        410,
        'HOLD_EXPIRED',
      );
      reloj.alPresente();
      const reserva = await comprar(tokenPartner(), 50);
      esperarProblemaV2(
        'createBooking',
        await v2('post', '/bookings', tokenPartner(), { 'Idempotency-Key': randomUUID() }).send(
          cuerpoReserva(reserva.holdId, { paymentReference: referenciaBooking() }),
        ),
        409,
        'HOLD_ALREADY_CONSUMED',
      );
    });

    it('createBooking: pasajeros que no son los del hold, 422 PASSENGER_COUNT_MISMATCH', async () => {
      const hold = await retener(tokenPartner(), 51);
      esperarProblemaV2(
        'createBooking',
        await v2('post', '/bookings', tokenPartner(), { 'Idempotency-Key': randomUUID() }).send({
          holdId: hold.holdId,
          passengers: [u.pasajero('ADULT', 900), u.pasajero('ADULT', 901)],
          payment: { paymentReference: referenciaBooking() },
        }),
        422,
        'PASSENGER_COUNT_MISMATCH',
      );
    });

    it('X-User-Id con un token de persona se ignora: ni se guarda ni filtra', async () => {
      const reserva = await comprar(tokenPersona(), 52, { 'X-User-Id': 'usr-impostor' });
      const [fila] = await prisma.db.$queryRaw<Json[]>`
        SELECT id_cliente, id_usuario_externo FROM vuelos.reserva_cabecera
         WHERE id = ${reserva.bookingId}::uuid`;
      expect(fila).toEqual({ id_cliente: null, id_usuario_externo: null });
      // Con otra X-User-Id la persona sigue viendo la suya (la cabecera no cuenta)
      esperarV2(
        'getBooking',
        await v2('get', `/bookings/${reserva.bookingId}`, tokenPersona(), {
          'X-User-Id': 'usr-otro',
        }),
        200,
      );
      const lista = await v2('get', '/bookings?limit=50', tokenPersona(), {
        'X-User-Id': 'usr-otro',
      });
      expect((lista.body.items as Json[]).some((i) => i.bookingId === reserva.bookingId)).toBe(
        true,
      );
    });

    it('un partner no ve las reservas de otro partner, ni las de otro usuario final', async () => {
      const deU1 = await comprar(tokenPartner(), 53, { 'X-User-Id': 'usr-uno' });
      esperarProblemaV2(
        'getBooking',
        await v2('get', `/bookings/${deU1.bookingId}`, tokenPartner(otroPartner)),
        404,
        'NOT_FOUND',
      );
      esperarProblemaV2(
        'getBooking',
        await v2('get', `/bookings/${deU1.bookingId}`, tokenPartner(), { 'X-User-Id': 'usr-dos' }),
        404,
        'NOT_FOUND',
      );
      esperarProblemaV2(
        'listTickets',
        await v2('get', `/bookings/${deU1.bookingId}/tickets`, tokenPartner(), {
          'X-User-Id': 'usr-dos',
        }),
        404,
        'NOT_FOUND',
      );
      esperarProblemaV2(
        'cancelBooking',
        await v2('post', `/bookings/${deU1.bookingId}/cancel`, tokenPartner(), {
          'X-User-Id': 'usr-dos',
          'Idempotency-Key': randomUUID(),
        }).send({ reasonCode: 'SAGA_COMPENSATION' }),
        404,
        'NOT_FOUND',
      );
      // Con su usuario o sin X-User-Id, el partner sí la ve
      esperarV2(
        'getBooking',
        await v2('get', `/bookings/${deU1.bookingId}`, tokenPartner(), { 'X-User-Id': 'usr-uno' }),
        200,
      );
      esperarV2('getBooking', await v2('get', `/bookings/${deU1.bookingId}`, tokenPartner()), 200);
    });

    it('listBookings: el partner con X-User-Id ve solo las de ese usuario; 401 sin token', async () => {
      const deU3 = await comprar(tokenPartner(), 54, { 'X-User-Id': 'usr-tres' });
      const deU4 = await comprar(tokenPartner(), 54, { 'X-User-Id': 'usr-cuatro' });
      const lista = esperarV2(
        'listBookings',
        await v2('get', '/bookings?limit=50', tokenPartner(), { 'X-User-Id': 'usr-tres' }),
        200,
      );
      const ids = (lista.items as Json[]).map((i) => i.bookingId);
      expect(ids).toContain(deU3.bookingId);
      expect(ids).not.toContain(deU4.bookingId);
      expect(lista.items[0]._links.self.href).toBe(`${V2}/bookings/${lista.items[0].bookingId}`);
      const todas = await v2('get', '/bookings?limit=50', tokenPartner());
      const deTodas = (todas.body.items as Json[]).map((i) => i.bookingId);
      expect(deTodas).toEqual(expect.arrayContaining([deU3.bookingId, deU4.bookingId]));
      esperarProblemaV2('listBookings', await v2('get', '/bookings'), 401, 'UNAUTHORIZED');
    });

    it('una X-User-Id con un formato que no se acepta, con un partner, es 400 (nombra la cabecera)', async () => {
      const respuesta = await v2('get', '/bookings', tokenPartner(), {
        'X-User-Id': 'con espacios',
      });
      expect(respuesta.status).toBe(400);
      expect(respuesta.body.invalidParams).toEqual([
        { name: 'X-User-Id', reason: expect.any(String) },
      ]);
      expect(respuesta.text).not.toContain('con espacios');
    });

    it('getBooking, listTickets, getTicket: 200 y 404', async () => {
      const reserva = await comprar(tokenPartner(), 55);
      esperarV2(
        'getBooking',
        await v2('get', `/bookings/${reserva.bookingId}`, tokenPartner()),
        200,
      );
      esperarProblemaV2(
        'getBooking',
        await v2('get', `/bookings/${randomUUID()}`, tokenPartner()),
        404,
        'NOT_FOUND',
      );
      const lista = esperarV2(
        'listTickets',
        await v2('get', `/bookings/${reserva.bookingId}/tickets`, tokenPartner()),
        200,
      );
      const ticketId = lista.tickets[0].ticketId as string;
      esperarV2(
        'getTicket',
        await v2('get', `/bookings/${reserva.bookingId}/tickets/${ticketId}`, tokenPartner()),
        200,
      );
      esperarProblemaV2(
        'getTicket',
        await v2('get', `/bookings/${reserva.bookingId}/tickets/${randomUUID()}`, tokenPartner()),
        404,
        'NOT_FOUND',
      );
      esperarProblemaV2(
        'listTickets',
        await v2('get', `/bookings/${randomUUID()}/tickets`, tokenPartner()),
        404,
        'NOT_FOUND',
      );
    });

    it('issueTickets: 200 issued 0 en una CONFIRMED; 404; 409 BOOKING_NOT_CONFIRMED si se canceló', async () => {
      const reserva = await comprar(tokenPartner(), 56);
      const emision = esperarV2(
        'issueTickets',
        await v2('post', `/bookings/${reserva.bookingId}/tickets`, tokenPartner()),
        200,
      );
      expect(emision).toMatchObject({
        bookingId: reserva.bookingId,
        status: 'CONFIRMED',
        issued: 0,
      });
      esperarProblemaV2(
        'issueTickets',
        await v2('post', `/bookings/${randomUUID()}/tickets`, tokenPartner()),
        404,
        'NOT_FOUND',
      );
      await v2('post', `/bookings/${reserva.bookingId}/cancel`, tokenPartner(), {
        'Idempotency-Key': randomUUID(),
      })
        .send({ reasonCode: 'SAGA_COMPENSATION' })
        .expect(200);
      esperarProblemaV2(
        'issueTickets',
        await v2('post', `/bookings/${reserva.bookingId}/tickets`, tokenPartner()),
        409,
        'BOOKING_NOT_CONFIRMED',
      );
    });
  });

  describe('Idempotencia v2', () => {
    it('createHold: misma clave y cuerpo, 200 con Idempotent-Replayed y el mismo cuerpo; otro cuerpo, 409', async () => {
      const oferta = await buscar(57);
      const clave = randomUUID();
      const primero = await v2('post', '/offers/hold', tokenPartner(), { 'Idempotency-Key': clave })
        .send(cuerpoHold(oferta))
        .expect(201);
      expect(primero.headers['idempotent-replayed']).toBeUndefined();
      const repetido = await v2('post', '/offers/hold', tokenPartner(), {
        'Idempotency-Key': clave,
      }).send(cuerpoHold(oferta));
      expect(esperarV2('createHold', repetido, 200)).toEqual(primero.body);
      expect(repetido.headers['idempotent-replayed']).toBe('true');
      esperarProblemaV2(
        'createHold',
        await v2('post', '/offers/hold', tokenPartner(), { 'Idempotency-Key': clave }).send(
          cuerpoHold(oferta, { adults: 2 }),
        ),
        409,
        'IDEMPOTENCY_KEY_REUSED',
      );
    });

    it('createBooking: el reintento es 200 con la reserva original; otro cuerpo, 409 IDEMPOTENCY_KEY_REUSED', async () => {
      const hold = await retener(tokenPartner(), 58);
      const clave = randomUUID();
      const cuerpo = cuerpoReserva(hold.holdId, { paymentReference: referenciaBooking() });
      const primero = await v2('post', '/bookings', tokenPartner(), { 'Idempotency-Key': clave })
        .send(cuerpo)
        .expect(201);
      const repetido = await v2('post', '/bookings', tokenPartner(), {
        'Idempotency-Key': clave,
      }).send(cuerpo);
      const reserva = esperarV2('createBooking', repetido, 200);
      expect(reserva.bookingId).toBe(primero.body.bookingId);
      expect(repetido.headers['idempotent-replayed']).toBe('true');
      esperarProblemaV2(
        'createBooking',
        await v2('post', '/bookings', tokenPartner(), { 'Idempotency-Key': clave }).send({
          ...cuerpo,
          payment: { paymentReference: referenciaBooking() },
        }),
        409,
        'IDEMPOTENCY_KEY_REUSED',
      );
      // La misma clave de otro partner es otra operación: no repite la de este
      const ajeno = await v2('post', '/bookings', tokenPartner(otroPartner), {
        'Idempotency-Key': clave,
      }).send(cuerpo);
      expect(ajeno.status).toBe(422);
    });

    it('la clave se recuerda 24 h (con el reloj de la prueba): pasado el plazo, vale como nueva', async () => {
      const oferta = await buscar(59);
      const clave = randomUUID();
      const primero = await v2('post', '/offers/hold', tokenPartner(), { 'Idempotency-Key': clave })
        .send(cuerpoHold(oferta))
        .expect(201);
      reloj.adelantar(23 * 60);
      const dentro = await v2('post', '/offers/hold', tokenPartner(), {
        'Idempotency-Key': clave,
      }).send(cuerpoHold(oferta, { adults: 2 }));
      expect(dentro.status).toBe(409);
      reloj.adelantar(61);
      // La oferta ya venció: con la clave libre, la petición se procesa de nuevo (y falla por la oferta)
      const fuera = await v2('post', '/offers/hold', tokenPartner(), {
        'Idempotency-Key': clave,
      }).send(cuerpoHold(oferta, { adults: 2 }));
      expect(fuera.status).toBe(409);
      expect(fuera.body.code).toBe('OFFER_NO_LONGER_AVAILABLE');
      expect(fuera.headers['idempotent-replayed']).toBeUndefined();
      expect(primero.body.holdId).toBeDefined();
    });
  });

  describe('MS.Reservas: check-in y pases', () => {
    it('checkIn y listBoardingPasses: 409 fuera de la ventana; 200 dentro; 404 de otra reserva', async () => {
      const reserva = await comprar(tokenPartner(), 60);
      const salida = new Date(reserva.itineraries[0].segments[0].departure.at).getTime();
      // 60 días antes de la salida, el check-in no abre (abre 48 h antes)
      esperarProblemaV2(
        'checkIn',
        await v2('post', `/bookings/${reserva.bookingId}/check-in`, tokenPartner()),
        409,
        'CHECK_IN_NOT_AVAILABLE',
      );
      // Sin check-in, la lista de pases está vacía (como en v1)
      const sinPases = esperarV2(
        'listBoardingPasses',
        await v2('get', `/bookings/${reserva.bookingId}/boarding-passes`, tokenPartner()),
        200,
      );
      expect(sinPases.boardingPasses).toEqual([]);
      reloj.fijar(new Date(salida - 24 * HORA));
      const checkin = esperarV2(
        'checkIn',
        await v2('post', `/bookings/${reserva.bookingId}/check-in`, tokenPartner()),
        200,
      );
      expect(checkin._links['boarding-passes'].href).toBe(
        `${V2}/bookings/${reserva.bookingId}/boarding-passes`,
      );
      esperarV2(
        'listBoardingPasses',
        await v2('get', `/bookings/${reserva.bookingId}/boarding-passes`, tokenPartner()),
        200,
      );
      esperarProblemaV2(
        'checkIn',
        await v2('post', `/bookings/${randomUUID()}/check-in`, tokenPartner()),
        404,
        'NOT_FOUND',
      );
      esperarProblemaV2(
        'listBoardingPasses',
        await v2('get', `/bookings/${randomUUID()}/boarding-passes`, tokenPartner()),
        404,
        'NOT_FOUND',
      );
      // El asiento quedó CHECKED_IN en el mapa
      const oferta = await buscar(60);
      const mapa = await v2(
        'get',
        `/offers/${oferta.offerId}/seatmap?segmentId=${oferta.itineraries[0].segments[0].segmentId}`,
      );
      const asiento = reserva.passengers[0].assignedSeats[0].seatNumber;
      const estados = (mapa.body.cabins as Json[]).flatMap((c) =>
        (c.rows as Json[]).flatMap((f) => f.seats as Json[]),
      );
      expect(estados.find((a) => a.seatNumber === asiento)?.status).toBe('CHECKED_IN');
    });
  });

  describe('MS.Postventa', () => {
    it('getBaggageOptions y addBaggage (BOOKING_PROTOTIPO, sin cobrar): 200; amount distinto 422; 404', async () => {
      const reserva = await comprar(tokenPartner(), 61);
      const opciones = esperarV2(
        'getBaggageOptions',
        await v2('get', `/bookings/${reserva.bookingId}/baggage-options`, tokenPartner()),
        200,
      );
      const opcion = (opciones as unknown as Json[])[0];
      const antes = pagos.autorizaciones.length;
      const pedido = (payment: Json) =>
        v2('post', `/bookings/${reserva.bookingId}/baggage`, tokenPartner(), {
          'Idempotency-Key': randomUUID(),
        }).send({
          passengerId: opcion.passengerId,
          itineraryId: opcion.itineraryId,
          quantity: 1,
          payment,
        });
      esperarProblemaV2(
        'addBaggage',
        await pedido({
          paymentReference: referenciaBooking(),
          amount: { currency: opcion.price.currency, total: '999.99' },
        }),
        422,
        'AMOUNT_MISMATCH',
      );
      esperarV2(
        'addBaggage',
        await pedido({
          paymentReference: referenciaBooking(),
          amount: { currency: opcion.price.currency, total: opcion.price.total },
        }),
        200,
      );
      expect(pagos.autorizaciones.length).toBe(antes);
      esperarProblemaV2(
        'getBaggageOptions',
        await v2('get', `/bookings/${randomUUID()}/baggage-options`, tokenPartner()),
        404,
        'NOT_FOUND',
      );
      esperarProblemaV2(
        'addBaggage',
        await v2('post', `/bookings/${randomUUID()}/baggage`, tokenPartner(), {
          'Idempotency-Key': randomUUID(),
        }).send({
          passengerId: opcion.passengerId,
          itineraryId: opcion.itineraryId,
          quantity: 1,
          payment: { paymentReference: referenciaBooking() },
        }),
        404,
        'NOT_FOUND',
      );
    });

    it('searchDateChange y confirmDateChange: 200 con el pago de Booking; 404', async () => {
      // Una familia que admite cambios (la primera opción puede ser BASIC, que no los admite)
      const oferta = await buscar(62);
      const opcion = (oferta.itineraries[0].pricingOptions as Json[]).find(
        (p) => p.fareRules.isChangeable,
      )!;
      const hold = await v2('post', '/offers/hold', tokenPartner(), {
        'Idempotency-Key': randomUUID(),
      })
        .send({
          offerId: oferta.offerId,
          itinerarySelections: [
            {
              itineraryId: oferta.itineraries[0].itineraryId,
              cabinClass: opcion.cabinClass,
              fareBrand: opcion.fareBrand,
            },
          ],
          passengersBreakdown: { adults: 1 },
        })
        .expect(201);
      const reserva = (
        await v2('post', '/bookings', tokenPartner(), { 'Idempotency-Key': randomUUID() })
          .send(cuerpoReserva(hold.body.holdId, { paymentReference: referenciaBooking() }))
          .expect(201)
      ).body as Json;
      const itinerario = reserva.itineraries[0].itineraryId as string;
      const opciones = esperarV2(
        'searchDateChange',
        await v2('post', `/bookings/${reserva.bookingId}/date-change/search`, tokenPartner()).send({
          changes: [{ itineraryId: itinerario, newDepartureDate: u.fechaEn(63) }],
        }),
        200,
      ) as unknown as Json[];
      expect(opciones.length).toBeGreaterThan(0);
      const cambio = opciones[0];
      const antes = pagos.autorizaciones.length;
      const confirmado = esperarV2(
        'confirmDateChange',
        await v2('post', `/bookings/${reserva.bookingId}/date-change`, tokenPartner(), {
          'Idempotency-Key': randomUUID(),
        }).send({
          changeOfferId: cambio.changeOfferId,
          payment: { paymentReference: referenciaBooking() },
        }),
        200,
      );
      expect(confirmado).toMatchObject({ bookingId: reserva.bookingId, status: 'CONFIRMED' });
      expect(pagos.autorizaciones.length).toBe(antes);
      esperarProblemaV2(
        'searchDateChange',
        await v2('post', `/bookings/${randomUUID()}/date-change/search`, tokenPartner()).send({
          changes: [{ itineraryId: itinerario, newDepartureDate: u.fechaEn(63) }],
        }),
        404,
        'NOT_FOUND',
      );
      esperarProblemaV2(
        'confirmDateChange',
        await v2('post', `/bookings/${randomUUID()}/date-change`, tokenPartner(), {
          'Idempotency-Key': randomUUID(),
        }).send({ changeOfferId: cambio.changeOfferId }),
        404,
        'NOT_FOUND',
      );
    });

    it('getCancellationQuote y cancelBooking con quoteId: refund CALCULATED (cobró Booking, no se reembolsa aquí)', async () => {
      // Una tarifa reembolsable: hay algo que devolver, y aun así la Payment API no se llama
      const reserva = await comprarConRegla(tokenPartner(), 64, 'isRefundable');
      const cotizacion = esperarV2(
        'getCancellationQuote',
        await v2('get', `/bookings/${reserva.bookingId}/cancellation-quote`, tokenPartner()),
        200,
      );
      expect(cotizacion.isRefundable).toBe(true);
      const antes = pagos.reembolsos.length;
      const cancelada = esperarV2(
        'cancelBooking',
        await v2('post', `/bookings/${reserva.bookingId}/cancel`, tokenPartner(), {
          'Idempotency-Key': randomUUID(),
        }).send({ quoteId: cotizacion.quoteId, reason: 'Cambio de planes' }),
        200,
      );
      expect(cancelada).toMatchObject({
        bookingId: reserva.bookingId,
        status: 'CANCELLED',
        reasonCode: 'CUSTOMER_REQUEST',
        refund: {
          refundId: cotizacion.quoteId,
          amount: cotizacion.refundAmount,
          penaltyAmount: cotizacion.penaltyAmount,
          currency: cotizacion.currency,
          originalPaymentReference: reserva.paymentReference,
          status: 'CALCULATED',
        },
        inventoryRestoration: { status: 'RESTORED', seatsReleased: 1, newSeatStatus: 'AVAILABLE' },
        ticketsVoided: [reserva.tickets[0].ticketId],
      });
      // Booking ejecuta el reembolso: la Payment API de la aerolínea no se llama
      expect(pagos.reembolsos.length).toBe(antes);
      esperarProblemaV2(
        'getCancellationQuote',
        await v2('get', `/bookings/${reserva.bookingId}/cancellation-quote`, tokenPartner()),
        409,
        'BOOKING_NOT_CANCELLABLE',
      );
      esperarProblemaV2(
        'getCancellationQuote',
        await v2('get', `/bookings/${randomUUID()}/cancellation-quote`, tokenPartner()),
        404,
        'NOT_FOUND',
      );
    });

    it('cancelBooking SAGA_COMPENSATION: sin quoteId, sin penalidad, y repetirla responde lo mismo', async () => {
      const reserva = await comprar(tokenPartner(), 65);
      const compensar = () =>
        v2('post', `/bookings/${reserva.bookingId}/cancel`, tokenPartner(), {
          'Idempotency-Key': randomUUID(),
        }).send({ reasonCode: 'SAGA_COMPENSATION' });
      const primera = esperarV2('cancelBooking', await compensar(), 200);
      expect(primera).toMatchObject({
        status: 'CANCELLED',
        reasonCode: 'SAGA_COMPENSATION',
        refund: {
          amount: reserva.grandTotal.total,
          penaltyAmount: '0.00',
          percentage: 100,
          status: 'CALCULATED',
        },
      });
      // Otra compensación (otra clave) sobre la ya cancelada: 200 con la misma cancelación
      const segunda = esperarV2('cancelBooking', await compensar(), 200);
      expect(segunda).toEqual(primera);
      // Una cancelación del cliente sobre la ya cancelada sí es 409 ALREADY_CANCELLED
      const cotizar = await v2('post', `/bookings/${reserva.bookingId}/cancel`, tokenPartner(), {
        'Idempotency-Key': randomUUID(),
      }).send({ quoteId: randomUUID() });
      expect(cotizar.status).toBe(422);
    });

    it('cancelBooking: sin quoteId y CUSTOMER_REQUEST es 400; de otra reserva 404', async () => {
      const reserva = await comprar(tokenPartner(), 66);
      const sinCotizacion = esperarProblemaV2(
        'cancelBooking',
        await v2('post', `/bookings/${reserva.bookingId}/cancel`, tokenPartner(), {
          'Idempotency-Key': randomUUID(),
        }).send({}),
        400,
        'VALIDATION_FAILED',
      );
      expect(sinCotizacion.invalidParams[0].name).toBe('quoteId');
      esperarProblemaV2(
        'cancelBooking',
        await v2('post', `/bookings/${randomUUID()}/cancel`, tokenPartner(), {
          'Idempotency-Key': randomUUID(),
        }).send({ reasonCode: 'SAGA_COMPENSATION' }),
        404,
        'NOT_FOUND',
      );
    });
  });

  describe('X-Correlation-Id', () => {
    it('el que llega se usa SIN cambios (respuesta y error) y uno inválido se reemplaza por corr-<uuid>', async () => {
      const valido = 'corr-Booking.combo:42_x-1';
      const ok = await v2('get', '/health', undefined, { 'X-Correlation-Id': valido });
      expect(ok.headers['x-correlation-id']).toBe(valido);
      const error = await v2('get', `/bookings/${randomUUID()}`, tokenPartner(), {
        'X-Correlation-Id': valido,
      });
      expect(error.headers['x-correlation-id']).toBe(valido);
      expect(error.body.correlation_id).toBe(valido);

      for (const invalido of ['con espacio', 'x'.repeat(101), 'corr/1', '']) {
        const r = await v2('get', '/health', undefined, { 'X-Correlation-Id': invalido });
        expect(r.headers['x-correlation-id']).toMatch(/^corr-[0-9a-f-]{36}$/);
      }
      const sin = await v2('get', '/health');
      expect(sin.headers['x-correlation-id']).toMatch(/^corr-[0-9a-f-]{36}$/);
    });

    it('v1 también lo devuelve, pero su ProblemDetails no cambia (sin correlation_id)', async () => {
      const r = await http()
        .get(`/flights/v1/bookings/${randomUUID()}`)
        .set('Authorization', `Bearer ${tokenPersona()}`)
        .set('X-Correlation-Id', 'corr-v1-0001');
      expect(r.status).toBe(404);
      expect(r.headers['x-correlation-id']).toBe('corr-v1-0001');
      expect(r.body.correlation_id).toBeUndefined();
      expect(r.body.code).toBe('VALIDATION_FAILED');
    });

    it('llega a la Payment API, a evento_saliente y a la cabecera de la publicación al notifier', async () => {
      const correlacion = `corr-compra-${randomUUID()}`;
      const cabecera = { 'X-Correlation-Id': correlacion };
      const oferta = await buscar(67);
      const hold = await v2('post', '/offers/hold', tokenPartner(), {
        ...cabecera,
        'Idempotency-Key': randomUUID(),
      })
        .send(cuerpoHold(oferta))
        .expect(201);
      const reserva = await v2('post', '/bookings', tokenPartner(), {
        ...cabecera,
        'Idempotency-Key': randomUUID(),
      })
        .send(
          cuerpoReserva(hold.body.holdId, {
            paymentReference: u.referenciaPago('OK'),
            provider: 'AIRLINE_DIRECT',
          }),
        )
        .expect(201);
      // La Payment API recibió el mismo id
      expect(pagos.autorizaciones.at(-1)?.correlationId).toBe(correlacion);

      const eventos = await prisma.db.$queryRaw<
        Array<{ tipo: string; correlation_id: string; sobre: string }>
      >`
        SELECT tipo, correlation_id, sobre FROM vuelos.evento_saliente
         WHERE sobre::jsonb -> 'data' ->> 'bookingId' = ${reserva.body.bookingId}`;
      expect(eventos.length).toBeGreaterThan(0);
      for (const evento of eventos) {
        expect(evento.correlation_id).toBe(correlacion);
        // Sin EVENT_ENVELOPE_CORRELATION_ID el sobre sigue siendo el 1.0 del notifier
        expect(JSON.parse(evento.sobre).correlationId).toBeUndefined();
      }

      notifier.reiniciar();
      const { RelevoEventos } =
        await import('../src/modules/vuelos/operaciones/webhook/relevo-eventos');
      await app.get(RelevoEventos).ejecutar();
      const publicadas = notifier.recibidas.filter((r) =>
        r.cuerpo.includes(reserva.body.bookingId as string),
      );
      expect(publicadas.length).toBe(eventos.length);
      for (const p of publicadas) expect(p.correlacion).toBe(correlacion);
    });

    it('cada línea de log de la compra lleva el id, y la línea de acceso en JSON trae los campos del contrato', async () => {
      const { LoggerPorPeticion } = await import('../src/common/logger/logger-por-peticion');
      const correlacion = `corr-log-${randomUUID()}`;
      const escrito: string[] = [];
      const espias = [process.stdout, process.stderr].map((salida) =>
        jest.spyOn(salida, 'write').mockImplementation((texto: string | Uint8Array) => {
          escrito.push(String(texto));
          return true;
        }),
      );
      app.useLogger(new LoggerPorPeticion());
      try {
        const oferta = await buscar(68);
        await v2('post', '/offers/hold', tokenPartner(), {
          'X-Correlation-Id': correlacion,
          'Idempotency-Key': randomUUID(),
        })
          .send(cuerpoHold(oferta))
          .expect(201);
        await v2('get', `/bookings/${randomUUID()}`, tokenPartner(), {
          'X-Correlation-Id': correlacion,
        }).expect(404);
        await new Promise((listo) => setTimeout(listo, 30));
      } finally {
        app.useLogger(false);
        espias.forEach((e) => e.mockRestore());
      }
      const lineas = escrito.join('').replace(COLORES_ANSI, '').split('\n').filter(Boolean);
      const accesos = lineas
        .filter((l) => l.startsWith('{'))
        .map((l) => JSON.parse(l) as Json)
        .filter((l) => l.correlation_id === correlacion);
      expect(accesos.map((a) => [a.operation, a.status])).toEqual([
        ['createHold', 201],
        ['getBooking', 404],
      ]);
      for (const acceso of accesos) {
        expect(Object.keys(acceso).sort()).toEqual(
          [
            'client_id',
            'correlation_id',
            'latency_ms',
            'level',
            'method',
            'operation',
            'request_id',
            'service',
            'status',
            'timestamp',
          ].sort(),
        );
        expect(acceso).toMatchObject({ service: 'core-vuelos', client_id: 'booking-prototipo' });
      }
      // Las líneas de texto de esas peticiones (acceso, errores) llevan [corr=...]
      const ids = new Set(accesos.map((a) => a.request_id as string));
      const deTexto = lineas.filter((l) => [...ids].some((id) => l.includes(`[${id}]`)));
      expect(deTexto.length).toBeGreaterThanOrEqual(2);
      for (const linea of deTexto) expect(linea).toContain(`[corr=${correlacion}]`);
      // Ni el token ni la X-User-Id en el log
      expect(escrito.join('')).not.toContain('Bearer ');
    });

    it('en gRPC se lee de la metadata x-correlation-id y se devuelve igual', async () => {
      const { puertoLibre, ClienteGrpc, valorDe } = await import('./utils/grpc');
      const { crearApp } = await import('./utils/crear-app');
      const puerto = await puertoLibre();
      const conGrpc = await crearApp([], { reloj, limites, grpc: puerto });
      const cliente = new ClienteGrpc(puerto);
      try {
        const resultado = await cliente.llamar(
          'GetFlightStatus',
          { flightNumber: 'ZZ9999', date: u.fechaEn(10) },
          { 'x-correlation-id': 'corr-grpc-0001' },
        );
        expect(valorDe(resultado.error?.metadata, 'x-correlation-id')).toBe('corr-grpc-0001');
        const sin = await cliente.llamar('GetFlightStatus', {
          flightNumber: 'ZZ9999',
          date: u.fechaEn(10),
        });
        expect(valorDe(sin.error?.metadata, 'x-correlation-id')).toMatch(/^corr-[0-9a-f-]{36}$/);
      } finally {
        cliente.cerrar();
        await conGrpc.close();
      }
    });
  });

  it('cobertura: cada operación implementada se probó con un éxito y al menos un error', () => {
    for (const operacion of IMPLEMENTADAS) {
      const probados = [...cobertura.get(operacion)!];
      expect({ operacion, exito: probados.some((s) => s < 300) }).toEqual({
        operacion,
        exito: true,
      });
      if (operacion !== 'getHealth') {
        expect({ operacion, error: probados.some((s) => s >= 400) }).toEqual({
          operacion,
          error: true,
        });
      }
    }
  });
});
