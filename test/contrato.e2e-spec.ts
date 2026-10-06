import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { desactivarUsuariosDePrueba } from './utils/auth';
import { CadenaBusqueda, crearCadena, darDeBajaCadena, HUELLA } from './utils/busqueda';
import { ADMIN, AppCatalogo, codigos, crearAppCatalogo } from './utils/catalogo';
import {
  erroresContraContrato,
  erroresContraReferencia,
  esquemaDeRespuesta,
  operacionesDelContrato,
} from './utils/contrato';
import { LimitesReiniciables } from './utils/limites';
import { agregarSalida } from './utils/postventa';
import { RelojDePrueba } from './utils/reloj';
import { con, nuevoCliente, pasajero, referenciaPago, RESERVAS } from './utils/reserva';

/**
 * Prueba de contrato: recorre las operaciones de contracts/vuelos-openapi.yaml, ejecuta un caso
 * feliz y uno de error de cada una contra la API real (base de pruebas, un catálogo propio) y
 * valida status y cuerpo con Ajv contra lo que el contrato declara para ese código.
 *
 * Lo que el contrato no declara y la API hace a propósito va en EXCEPCIONES, cada una con su
 * motivo (ver docs/DISCREPANCIAS-CONTRATO.md). Un status que no está ni en el contrato ni ahí
 * hace fallar la prueba; también una operación del contrato sin ruta o sin sus dos casos.
 */

interface Excepcion {
  operacion: string;
  codigo: number;
  motivo: string;
  /** Esquema de components.schemas con el que se valida el cuerpo en lugar del declarado. */
  esquema?: string;
}

export const EXCEPCIONES: Excepcion[] = [
  {
    operacion: 'GET /bookings',
    codigo: 400,
    motivo: 'El contrato no declara errores; un filtro inválido (limit=0) es 400 ProblemDetails',
  },
  {
    operacion: 'GET /bookings/{bookingId}/baggage-options',
    codigo: 404,
    motivo: 'El contrato no declara errores; una reserva ajena o inexistente es 404',
  },
  {
    operacion: 'GET /bookings/{bookingId}/cancellation-quote',
    codigo: 404,
    motivo: 'El contrato no declara errores; una reserva ajena o inexistente es 404',
  },
  {
    operacion: 'POST /bookings/{bookingId}/cancel',
    codigo: 200,
    motivo: 'El 200 no declara cuerpo; la API devuelve el BookingDetail de la reserva cancelada',
    esquema: 'BookingDetail',
  },
  {
    operacion: 'GET /webhooks',
    codigo: 401,
    motivo: 'El contrato no declara 401 en ninguna operación; sin token, 401 ProblemDetails',
  },
  {
    operacion: 'POST /webhooks',
    codigo: 400,
    motivo: 'El contrato solo declara 201; un cuerpo inválido es 400 ProblemDetails',
  },
  {
    operacion: 'DELETE /webhooks/{id}',
    codigo: 404,
    motivo: 'El contrato solo declara 204; una suscripción ajena o inexistente es 404',
  },
];

type Respuesta = request.Response;

const OPERACIONES = operacionesDelContrato();
const cubiertas = new Map<string, Set<'feliz' | 'error'>>();
const excepcionesUsadas = new Set<Excepcion>();

/** Comprueba la respuesta contra el contrato (o una excepción) y la anota como cubierta. */
function comprobar(operacion: string, caso: 'feliz' | 'error', respuesta: Respuesta): void {
  const op = OPERACIONES.find((o) => o.clave === operacion);
  if (!op) throw new Error(`${operacion} no está en el contrato`);
  const codigo = respuesta.status;
  if (caso === 'feliz' && codigo >= 400) {
    throw new Error(
      `${operacion}: el caso feliz respondió ${codigo}: ${JSON.stringify(respuesta.body)}`,
    );
  }
  if (caso === 'error' && codigo < 400) {
    throw new Error(`${operacion}: el caso de error respondió ${codigo}`);
  }
  const excepcion = EXCEPCIONES.find((e) => e.operacion === operacion && e.codigo === codigo);
  const declarado = esquemaDeRespuesta(op.metodo, op.ruta, codigo);
  if (declarado === undefined && !excepcion) {
    throw new Error(
      `${operacion} respondió ${codigo}, que el contrato no declara (${op.codigos.join(', ')}) ni está en EXCEPCIONES`,
    );
  }
  if (excepcion) excepcionesUsadas.add(excepcion);
  let errores: string[];
  if (codigo >= 400) {
    expect(respuesta.type).toBe('application/problem+json');
    errores = erroresContraContrato('ProblemDetails', respuesta.body);
  } else if (excepcion?.esquema) {
    errores = erroresContraContrato(excepcion.esquema, respuesta.body);
  } else if (declarado) {
    errores = erroresContraReferencia(declarado, respuesta.body);
  } else {
    // Sin cuerpo declarado (204, 202): no se exige forma, pero sí que no sea un error
    errores = [];
  }
  if (errores.length > 0) {
    throw new Error(`${operacion} ${codigo} no cumple el contrato:\n${errores.join('\n')}`);
  }
  const registro = cubiertas.get(operacion) ?? new Set();
  registro.add(caso);
  cubiertas.set(operacion, registro);
}

describe('Contrato: las 22 operaciones contra la API real', () => {
  const reloj = new RelojDePrueba();
  const limites = new LimitesReiniciables();
  let c: AppCatalogo;
  let k: CadenaBusqueda;
  let cliente: { id: string; token: string };
  let otro: { id: string; token: string };
  let nueva: { salida: string; fecha: string };
  const yo = () => con(c.app, cliente.token);
  const publico = () => con(c.app);

  // Lo que el flujo va dejando
  let oferta: { offerId: string; itineraryId: string; cabinClass: string; fareBrand: string };
  let holdId: string;
  let reserva: { bookingId: string; itineraryId: string; ticketId: string };
  let webhookId: string;

  beforeAll(async () => {
    c = await crearAppCatalogo({ reloj, limites });
    k = await crearCadena(c);
    await c
      .admin('patch', `${ADMIN}/airlines/${k.aerolinea}`, {
        ticketPrefix: await codigos.prefijoBoleto(c.prisma),
      })
      .expect(200);
    await c
      .admin('patch', `${ADMIN}/fare-families/${k.familia}`, {
        changeable: true,
        cancellationPenaltyPercent: '50',
      })
      .expect(200);
    await c
      .admin('patch', `${ADMIN}/departures/${k.salida}`, {
        cabins: [{ cabinClass: 'ECONOMY', totalSeats: 6 }],
      })
      .expect(200);
    await c.admin('patch', `${ADMIN}/fares/${k.tarifa}`, { changeFee: '5.00' }).expect(200);
    nueva = await agregarSalida(c, k, 22, 6, { baseFare: '70.00', taxes: '14.00' });
    cliente = await nuevoCliente(c.app);
    otro = await nuevoCliente(c.app);
  });
  beforeEach(() => limites.reiniciar());
  afterAll(async () => {
    reloj.alPresente();
    if (holdId) await yo()('delete', `/flights/v1/offers/hold/${holdId}`);
    await c.admin('delete', `${ADMIN}/departures/${nueva.salida}`);
    await c.admin('patch', `${ADMIN}/airlines/${k.aerolinea}`, { ticketPrefix: null });
    await darDeBajaCadena(c, k);
    await desactivarUsuariosDePrueba(c.app);
    await c.cerrar();
  });

  it('cada operación del contrato tiene una ruta en la API (método y path)', () => {
    const router = (
      c.app.getHttpAdapter().getInstance() as {
        _router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> };
      }
    )._router;
    const rutas = new Set(
      router.stack
        .filter((capa) => capa.route)
        .flatMap((capa) =>
          Object.keys(capa.route!.methods).map((m) => `${m.toUpperCase()} ${capa.route!.path}`),
        ),
    );
    const faltan = OPERACIONES.filter(
      (op) => !rutas.has(`${op.metodo} /flights/v1${op.ruta.replace(/\{(\w+)\}/g, ':$1')}`),
    ).map((op) => op.clave);
    expect(faltan).toEqual([]);
    expect(OPERACIONES).toHaveLength(22);
  });

  it('POST /search', async () => {
    const feliz = await publico()('post', '/flights/v1/search')
      .set('X-Device-Fingerprint', HUELLA)
      .send({
        itineraries: [{ origin: k.origen, destination: k.destino, departureDate: k.fecha }],
        passengers: { adults: 1 },
      });
    comprobar('POST /search', 'feliz', feliz);
    const [primera] = feliz.body.offers;
    const it0 = primera.itineraries[0];
    oferta = {
      offerId: primera.offerId,
      itineraryId: it0.itineraryId,
      cabinClass: it0.pricingOptions[0].cabinClass,
      fareBrand: it0.pricingOptions[0].fareBrand,
    };
    comprobar(
      'POST /search',
      'error',
      await publico()('post', '/flights/v1/search').set('X-Device-Fingerprint', HUELLA).send({}),
    );
  });

  it('GET /offers/{offerId}/seatmap', async () => {
    comprobar(
      'GET /offers/{offerId}/seatmap',
      'feliz',
      await publico()('get', `/flights/v1/offers/${oferta.offerId}/seatmap?segmentId=${k.salida}`),
    );
    comprobar(
      'GET /offers/{offerId}/seatmap',
      'error',
      await publico()('get', `/flights/v1/offers/${randomUUID()}/seatmap?segmentId=${k.salida}`),
    );
  });

  const cuerpoHold = () => ({
    offerId: oferta.offerId,
    itinerarySelections: [
      {
        itineraryId: oferta.itineraryId,
        cabinClass: oferta.cabinClass,
        fareBrand: oferta.fareBrand,
      },
    ],
    passengersBreakdown: { adults: 1 },
  });

  it('POST /offers/hold', async () => {
    const feliz = await yo()('post', '/flights/v1/offers/hold')
      .set('Idempotency-Key', randomUUID())
      .send(cuerpoHold());
    comprobar('POST /offers/hold', 'feliz', feliz);
    holdId = feliz.body.holdId;
    // Sin Idempotency-Key
    comprobar(
      'POST /offers/hold',
      'error',
      await yo()('post', '/flights/v1/offers/hold').send(cuerpoHold()),
    );
  });

  it('GET /offers/hold/{holdId}', async () => {
    comprobar(
      'GET /offers/hold/{holdId}',
      'feliz',
      await yo()('get', `/flights/v1/offers/hold/${holdId}`),
    );
    // El de otro usuario no existe para él
    comprobar(
      'GET /offers/hold/{holdId}',
      'error',
      await con(c.app, otro.token)('get', `/flights/v1/offers/hold/${holdId}`),
    );
  });

  it('POST /bookings', async () => {
    const feliz = await yo()('post', RESERVAS)
      .set('Idempotency-Key', randomUUID())
      .send({
        holdId,
        passengers: [pasajero('ADULT', 1)],
        payment: { paymentReference: referenciaPago() },
      });
    comprobar('POST /bookings', 'feliz', feliz);
    reserva = {
      bookingId: feliz.body.bookingId,
      itineraryId: feliz.body.itineraries[0].itineraryId,
      ticketId: feliz.body.tickets[0].ticketId,
    };
    holdId = '';
    // Un hold que no existe: 422
    comprobar(
      'POST /bookings',
      'error',
      await yo()('post', RESERVAS)
        .set('Idempotency-Key', randomUUID())
        .send({
          holdId: randomUUID(),
          passengers: [pasajero('ADULT', 1)],
          payment: { paymentReference: referenciaPago() },
        }),
    );
  });

  it('DELETE /offers/hold/{holdId}', async () => {
    const otroHold = await yo()('post', '/flights/v1/offers/hold')
      .set('Idempotency-Key', randomUUID())
      .send(cuerpoHold());
    expect(otroHold.status).toBe(201);
    comprobar(
      'DELETE /offers/hold/{holdId}',
      'feliz',
      await yo()('delete', `/flights/v1/offers/hold/${otroHold.body.holdId}`),
    );
    comprobar(
      'DELETE /offers/hold/{holdId}',
      'error',
      await yo()('delete', `/flights/v1/offers/hold/${randomUUID()}`),
    );
  });

  it('GET /bookings', async () => {
    comprobar('GET /bookings', 'feliz', await yo()('get', `${RESERVAS}?status=CONFIRMED`));
    comprobar('GET /bookings', 'error', await yo()('get', `${RESERVAS}?limit=0`));
  });

  it('GET /bookings/{bookingId}', async () => {
    comprobar(
      'GET /bookings/{bookingId}',
      'feliz',
      await yo()('get', `${RESERVAS}/${reserva.bookingId}`),
    );
    comprobar(
      'GET /bookings/{bookingId}',
      'error',
      await con(c.app, otro.token)('get', `${RESERVAS}/${reserva.bookingId}`),
    );
  });

  it('GET /bookings/{bookingId}/tickets', async () => {
    comprobar(
      'GET /bookings/{bookingId}/tickets',
      'feliz',
      await yo()('get', `${RESERVAS}/${reserva.bookingId}/tickets`),
    );
    comprobar(
      'GET /bookings/{bookingId}/tickets',
      'error',
      await yo()('get', `${RESERVAS}/${randomUUID()}/tickets`),
    );
  });

  it('GET /bookings/{bookingId}/tickets/{ticketId}', async () => {
    comprobar(
      'GET /bookings/{bookingId}/tickets/{ticketId}',
      'feliz',
      await yo()('get', `${RESERVAS}/${reserva.bookingId}/tickets/${reserva.ticketId}`),
    );
    comprobar(
      'GET /bookings/{bookingId}/tickets/{ticketId}',
      'error',
      await yo()('get', `${RESERVAS}/${reserva.bookingId}/tickets/9999999999999`),
    );
  });

  it('GET /bookings/{bookingId}/baggage-options', async () => {
    comprobar(
      'GET /bookings/{bookingId}/baggage-options',
      'feliz',
      await yo()('get', `${RESERVAS}/${reserva.bookingId}/baggage-options`),
    );
    comprobar(
      'GET /bookings/{bookingId}/baggage-options',
      'error',
      await yo()('get', `${RESERVAS}/${randomUUID()}/baggage-options`),
    );
  });

  it('POST /bookings/{bookingId}/baggage', async () => {
    const maleta = (cantidad: number) => ({
      passengerId: 'ADU1',
      itineraryId: reserva.itineraryId,
      quantity: cantidad,
      payment: { paymentReference: referenciaPago() },
    });
    const ruta = `${RESERVAS}/${reserva.bookingId}/baggage`;
    comprobar(
      'POST /bookings/{bookingId}/baggage',
      'feliz',
      await yo()('post', ruta).set('Idempotency-Key', randomUUID()).send(maleta(1)),
    );
    // Pasa el máximo de la familia (3 por pasajero e itinerario): 409
    comprobar(
      'POST /bookings/{bookingId}/baggage',
      'error',
      await yo()('post', ruta).set('Idempotency-Key', randomUUID()).send(maleta(3)),
    );
  });

  it('POST /bookings/{bookingId}/date-change/search y POST .../date-change', async () => {
    const buscar = () =>
      yo()('post', `${RESERVAS}/${reserva.bookingId}/date-change/search`).send({
        changes: [{ itineraryId: reserva.itineraryId, newDepartureDate: nueva.fecha }],
      });
    const confirmar = (changeOfferId: string) =>
      yo()('post', `${RESERVAS}/${reserva.bookingId}/date-change`)
        .set('Idempotency-Key', randomUUID())
        .send({ changeOfferId, payment: { paymentReference: referenciaPago() } });

    const busqueda = await buscar();
    comprobar('POST /bookings/{bookingId}/date-change/search', 'feliz', busqueda);
    // Una oferta vencida: 410
    reloj.alPresente();
    const vieja = (await buscar()).body[0].changeOfferId;
    reloj.adelantar(16);
    comprobar('POST /bookings/{bookingId}/date-change', 'error', await confirmar(vieja));
    reloj.alPresente();
    const vigente = (await buscar()).body[0].changeOfferId;
    const cambio = await confirmar(vigente);
    comprobar('POST /bookings/{bookingId}/date-change', 'feliz', cambio);
    reserva.itineraryId = cambio.body.itineraries[0].itineraryId;
  });

  it('POST /bookings/{bookingId}/check-in y GET .../boarding-passes', async () => {
    const ruta = `${RESERVAS}/${reserva.bookingId}/check-in`;
    // Hoy el vuelo (día 22) todavía no abre su check-in: 409
    reloj.alPresente();
    comprobar('POST /bookings/{bookingId}/check-in', 'error', await yo()('post', ruta));
    const salida = await c.admin('get', `${ADMIN}/departures/${nueva.salida}`).expect(200);
    reloj.fijar(new Date(new Date(salida.body.scheduledDeparture).getTime() - 24 * 3_600_000));
    comprobar('POST /bookings/{bookingId}/check-in', 'feliz', await yo()('post', ruta));
    comprobar(
      'GET /bookings/{bookingId}/boarding-passes',
      'feliz',
      await yo()('get', `${RESERVAS}/${reserva.bookingId}/boarding-passes`),
    );
    comprobar(
      'GET /bookings/{bookingId}/boarding-passes',
      'error',
      await con(c.app, otro.token)('get', `${RESERVAS}/${reserva.bookingId}/boarding-passes`),
    );
  });

  it('GET /flights/{flightNumber}/status', async () => {
    comprobar(
      'GET /flights/{flightNumber}/status',
      'feliz',
      await publico()('get', `/flights/v1/flights/${k.vuelo}/status?date=${nueva.fecha}`),
    );
    comprobar(
      'GET /flights/{flightNumber}/status',
      'error',
      await publico()('get', `/flights/v1/flights/${k.aerolinea}9998/status?date=${nueva.fecha}`),
    );
  });

  it('GET .../cancellation-quote, POST .../cancel y date-change/search sobre una cancelada', async () => {
    const cotizacion = await yo()('get', `${RESERVAS}/${reserva.bookingId}/cancellation-quote`);
    comprobar('GET /bookings/{bookingId}/cancellation-quote', 'feliz', cotizacion);
    comprobar(
      'GET /bookings/{bookingId}/cancellation-quote',
      'error',
      await yo()('get', `${RESERVAS}/${randomUUID()}/cancellation-quote`),
    );
    const cancelar = () =>
      yo()('post', `${RESERVAS}/${reserva.bookingId}/cancel`)
        .set('Idempotency-Key', randomUUID())
        .send({ quoteId: cotizacion.body.quoteId });
    comprobar('POST /bookings/{bookingId}/cancel', 'feliz', await cancelar());
    // La cotización ya se usó: 409
    comprobar('POST /bookings/{bookingId}/cancel', 'error', await cancelar());
    // Una reserva cancelada no se cambia: 409
    comprobar(
      'POST /bookings/{bookingId}/date-change/search',
      'error',
      await yo()('post', `${RESERVAS}/${reserva.bookingId}/date-change/search`).send({
        changes: [{ itineraryId: reserva.itineraryId, newDepartureDate: k.fecha }],
      }),
    );
  });

  it('GET, POST y DELETE /webhooks', async () => {
    const alta = await yo()('post', '/flights/v1/webhooks').send({
      url: `http://localhost:9/contrato/${randomUUID()}`,
      events: ['booking.confirmed'],
      secret: 'secreto-de-la-prueba-de-contrato',
    });
    comprobar('POST /webhooks', 'feliz', alta);
    webhookId = alta.body.id;
    comprobar(
      'POST /webhooks',
      'error',
      await yo()('post', '/flights/v1/webhooks').send({ url: 'x', events: [], secret: 'corto' }),
    );
    comprobar('GET /webhooks', 'feliz', await yo()('get', '/flights/v1/webhooks'));
    comprobar('GET /webhooks', 'error', await publico()('get', '/flights/v1/webhooks'));
    comprobar(
      'DELETE /webhooks/{id}',
      'feliz',
      await yo()('delete', `/flights/v1/webhooks/${webhookId}`),
    );
    comprobar(
      'DELETE /webhooks/{id}',
      'error',
      await yo()('delete', `/flights/v1/webhooks/${webhookId}`),
    );
  });

  it('las 22 operaciones quedaron cubiertas con un caso feliz y uno de error', () => {
    const faltan = OPERACIONES.filter(
      (op) => !(cubiertas.get(op.clave)?.has('feliz') && cubiertas.get(op.clave)?.has('error')),
    ).map((op) => `${op.clave} (${[...(cubiertas.get(op.clave) ?? [])].join(', ') || 'nada'})`);
    expect(faltan).toEqual([]);
  });

  it('cada excepción se usó: no quedan excepciones de más', () => {
    const sinUsar = EXCEPCIONES.filter((e) => !excepcionesUsadas.has(e)).map(
      (e) => `${e.operacion} ${e.codigo}`,
    );
    expect(sinUsar).toEqual([]);
    for (const e of EXCEPCIONES) expect(e.motivo.length).toBeGreaterThan(10);
  });
});
