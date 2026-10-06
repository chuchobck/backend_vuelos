import { randomUUID } from 'node:crypto';
import { PagosSimulados } from '../src/modules/vuelos/compartido/pagos/pagos-simulados';
import { PendientesPostventa } from '../src/modules/vuelos/operaciones/pendientes-postventa';
import { desactivarUsuariosDePrueba } from './utils/auth';
import { CadenaBusqueda, crearCadena, darDeBajaCadena } from './utils/busqueda';
import { ADMIN, AppCatalogo, codigos, crearAppCatalogo } from './utils/catalogo';
import { LimitesReiniciables } from './utils/limites';
import { cancelarReservasDe, estadoEnBase } from './utils/postventa';
import { esperarProblemDetails } from './utils/problem-details';
import { RelojDePrueba } from './utils/reloj';
import {
  buscarYRetener,
  con,
  cuerpoReserva,
  cupoDe,
  HOLD,
  nuevoCliente,
  pasajero,
  referenciaPago,
  reservar,
  RESERVAS,
} from './utils/reserva';

/**
 * Ramas de los módulos críticos (pagos simulados, reserva y cancelación) que la cobertura de la
 * fase 11 mostró sin probar: el vuelo del hold que deja de venderse o ya salió al reservar, la
 * cancelación con un pago de maleta pendiente y la clave de idempotencia de la cancelación
 * reusada con otro cuerpo.
 */

describe('PagosSimulados: la regla del prefijo, completa', () => {
  const pagos = new PagosSimulados();
  const cobro = (referencia: string) => ({
    referencia,
    monto: '10.00',
    moneda: 'USD',
    concepto: 'EMISION',
  });

  it.each([
    ['PAY-OK-ABCD1234', 'APROBADO', 'APROBADO', 'APROBADO', 'APROBADO'],
    ['PAY-PEND-ABCD1234', 'PENDIENTE', 'APROBADO', 'PENDIENTE', 'APROBADO'],
    ['PAY-REJ-ABCD1234', 'RECHAZADO', 'RECHAZADO', 'RECHAZADO', 'RECHAZADO'],
    ['PAY-OK-abc', 'INVALIDO', 'RECHAZADO', 'RECHAZADO', 'RECHAZADO'],
    ['PAY-OK-ABC', 'INVALIDO', 'RECHAZADO', 'RECHAZADO', 'RECHAZADO'],
    [`PAY-OK-${'A'.repeat(51)}`, 'INVALIDO', 'RECHAZADO', 'RECHAZADO', 'RECHAZADO'],
    ['OTRA-COSA', 'INVALIDO', 'RECHAZADO', 'RECHAZADO', 'RECHAZADO'],
  ])(
    '%s: autorizar %s, consultar %s, reembolsar %s, consultar reembolso %s',
    async (referencia, autorizar, consultar, reembolsar, consultarReembolso) => {
      expect(await pagos.autorizar(cobro(referencia) as never)).toBe(autorizar);
      expect(await pagos.consultar(referencia)).toBe(consultar);
      const pedido = { referenciaPago: referencia, monto: '5.00', moneda: 'USD' } as never;
      expect(await pagos.reembolsar(pedido)).toBe(reembolsar);
      expect(await pagos.consultarReembolso(pedido)).toBe(consultarReembolso);
    },
  );
});

describe('Ramas críticas de la reserva y la cancelación', () => {
  const reloj = new RelojDePrueba();
  const limites = new LimitesReiniciables();
  let c: AppCatalogo;
  let k: CadenaBusqueda;
  let cliente: { id: string; token: string };

  const retener = () =>
    buscarYRetener(c.app, cliente.token, [[k.origen, k.destino, k.fecha]], { adults: 1 });
  const reservaConfirmada = async () => {
    const retenido = await retener();
    return (
      await reservar(
        c.app,
        cliente.token,
        cuerpoReserva(retenido.holdId, [pasajero('ADULT', 1)], referenciaPago()),
      ).expect(201)
    ).body;
  };

  beforeAll(async () => {
    c = await crearAppCatalogo({ reloj, limites });
    k = await crearCadena(c);
    await c
      .admin('patch', `${ADMIN}/airlines/${k.aerolinea}`, {
        ticketPrefix: await codigos.prefijoBoleto(c.prisma),
      })
      .expect(200);
    await c
      .admin('patch', `${ADMIN}/departures/${k.salida}`, {
        cabins: [{ cabinClass: 'ECONOMY', totalSeats: 6 }],
      })
      .expect(200);
    cliente = await nuevoCliente(c.app);
  });
  beforeEach(() => {
    reloj.alPresente();
    limites.reiniciar();
  });
  afterAll(async () => {
    reloj.alPresente();
    await cancelarReservasDe(c.app, cliente.token);
    await c.admin('patch', `${ADMIN}/airlines/${k.aerolinea}`, { ticketPrefix: null });
    await darDeBajaCadena(c, k);
    await desactivarUsuariosDePrueba(c.app);
    await c.cerrar();
  });

  it('un hold cuyo vuelo pasó a BOARDING no se reserva: 409 OFFER_NO_LONGER_AVAILABLE y el hold sigue', async () => {
    const retenido = await retener();
    const antes = await cupoDe(c.prisma, k.salida);
    await c.admin('patch', `${ADMIN}/departures/${k.salida}`, { status: 'BOARDING' }).expect(200);
    try {
      const respuesta = await reservar(
        c.app,
        cliente.token,
        cuerpoReserva(retenido.holdId, [pasajero('ADULT', 1)]),
      );
      expect(respuesta.status).toBe(409);
      esperarProblemDetails(respuesta);
      expect(respuesta.body.code).toBe('OFFER_NO_LONGER_AVAILABLE');
      const hold = await con(c.app, cliente.token)('get', `${HOLD}/${retenido.holdId}`).expect(200);
      expect(hold.body.status).toBe('HELD');
      expect(await cupoDe(c.prisma, k.salida)).toEqual(antes);
    } finally {
      await c
        .admin('patch', `${ADMIN}/departures/${k.salida}`, { status: 'SCHEDULED' })
        .expect(200);
      await con(c.app, cliente.token)('delete', `${HOLD}/${retenido.holdId}`).expect(204);
    }
  });

  it('un hold vigente cuyo vuelo ya salió: 409 FLIGHT_ALREADY_DEPARTED, sin reserva', async () => {
    // Una salida dentro de 10 minutos (la oferta de la búsqueda vence con la hora real, así que
    // el vuelo tiene que estar cerca de verdad); se retiene ahora y se reserva 11 minutos después
    const ahora = Date.now();
    const salida = await c
      .admin('post', `${ADMIN}/departures`, {
        flightNumber: k.vuelo,
        seatMapId: k.mapa,
        scheduledDeparture: new Date(ahora + 10 * 60_000).toISOString(),
        scheduledArrival: new Date(ahora + 70 * 60_000).toISOString(),
        cabins: [
          { cabinClass: 'ECONOMY', totalSeats: 2 },
          { cabinClass: 'BUSINESS', totalSeats: 0 },
        ],
      })
      .expect(201);
    const tarifa = await c.admin('post', `${ADMIN}/fares`, {
      departureId: salida.body.id,
      fareFamilyId: k.familia,
      currency: 'USD',
      extraBagPrice: '20',
      prices: [
        { passengerType: 'ADULT', baseFare: '50.00', taxes: '10.00' },
        { passengerType: 'CHILD', baseFare: '40.00', taxes: '8.00' },
        { passengerType: 'INFANT', baseFare: '5.00', taxes: '1.00' },
      ],
    });
    try {
      expect(tarifa.status).toBe(201);
      const retenido = await buscarYRetener(
        c.app,
        cliente.token,
        [[k.origen, k.destino, salida.body.departureDate]],
        { adults: 1 },
      );
      expect(retenido.oferta.itineraries[0].segments[0].segmentId).toBe(salida.body.id);
      reloj.adelantar(11);
      const respuesta = await reservar(
        c.app,
        cliente.token,
        cuerpoReserva(retenido.holdId, [pasajero('ADULT', 1)]),
      );
      expect(respuesta.status).toBe(409);
      esperarProblemDetails(respuesta);
      expect(respuesta.body.code).toBe('FLIGHT_ALREADY_DEPARTED');
      expect(
        await c.prisma.db.reserva_cabecera.count({ where: { retencion_id: retenido.holdId } }),
      ).toBe(0);
      reloj.alPresente();
      await con(c.app, cliente.token)('delete', `${HOLD}/${retenido.holdId}`).expect(204);
    } finally {
      if (tarifa.body.id) await c.admin('delete', `${ADMIN}/fares/${tarifa.body.id}`).expect(204);
      await c.admin('delete', `${ADMIN}/departures/${salida.body.id}`).expect(204);
    }
  });

  it('cancelar con un pago de maleta pendiente: 409; resuelto el pago, se cancela', async () => {
    const reserva = await reservaConfirmada();
    const maleta = await con(c.app, cliente.token)(
      'post',
      `${RESERVAS}/${reserva.bookingId}/baggage`,
    )
      .set('Idempotency-Key', randomUUID())
      .send({
        passengerId: 'ADU1',
        itineraryId: reserva.itineraries[0].itineraryId,
        quantity: 1,
        payment: { paymentReference: referenciaPago('PEND') },
      })
      .expect(202);
    expect(maleta.status).toBe(202);
    const cotizar = () =>
      con(c.app, cliente.token)('get', `${RESERVAS}/${reserva.bookingId}/cancellation-quote`);
    const cancelar = (quoteId: string) =>
      con(c.app, cliente.token)('post', `${RESERVAS}/${reserva.bookingId}/cancel`)
        .set('Idempotency-Key', randomUUID())
        .send({ quoteId });
    // La cotización también se niega con el pago pendiente
    expect((await cotizar()).status).toBe(409);
    await c.app.get(PendientesPostventa).ejecutar();
    const cotizacion = await cotizar().expect(200);
    // Una maleta nueva pendiente entre la cotización y la cancelación: la cancelación es 409
    await con(c.app, cliente.token)('post', `${RESERVAS}/${reserva.bookingId}/baggage`)
      .set('Idempotency-Key', randomUUID())
      .send({
        passengerId: 'ADU1',
        itineraryId: reserva.itineraries[0].itineraryId,
        quantity: 1,
        payment: { paymentReference: referenciaPago('PEND') },
      })
      .expect(202);
    const bloqueada = await cancelar(cotizacion.body.quoteId);
    expect(bloqueada.status).toBe(409);
    esperarProblemDetails(bloqueada);
    expect(bloqueada.body.detail).toMatch(/payment pending/);
    expect((await estadoEnBase(c.prisma, reserva.bookingId)).estado).toBe('CONFIRMADA');
    await c.app.get(PendientesPostventa).ejecutar();
    const nueva = await cotizar().expect(200);
    const cancelada = await cancelar(nueva.body.quoteId).expect(200);
    expect(cancelada.body.status).toBe('CANCELLED');
  });

  it('la clave de idempotencia de la cancelación: repetir da lo mismo; con otro cuerpo, 422', async () => {
    const reserva = await reservaConfirmada();
    const cotizacion = await con(c.app, cliente.token)(
      'get',
      `${RESERVAS}/${reserva.bookingId}/cancellation-quote`,
    ).expect(200);
    const clave = randomUUID();
    const cancelar = (cuerpo: object) =>
      con(c.app, cliente.token)('post', `${RESERVAS}/${reserva.bookingId}/cancel`)
        .set('Idempotency-Key', clave)
        .send(cuerpo);
    const primera = await cancelar({ quoteId: cotizacion.body.quoteId }).expect(200);
    const repetida = await cancelar({ quoteId: cotizacion.body.quoteId }).expect(200);
    expect(repetida.headers['idempotent-replayed']).toBe('true');
    expect(repetida.body.status).toBe(primera.body.status);
    const otroCuerpo = await cancelar({ quoteId: cotizacion.body.quoteId, reason: 'Otro motivo' });
    expect(otroCuerpo.status).toBe(422);
    esperarProblemDetails(otroCuerpo);
    expect(otroCuerpo.body.invalidParams).toEqual([
      { name: 'Idempotency-Key', reason: 'already used with another body' },
    ]);
  });
});
