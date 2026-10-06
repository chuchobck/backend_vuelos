import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  SERVICIO_PAGOS,
  ServicioPagos,
} from '../src/modules/vuelos/compartido/pagos/servicio-pagos';
import { PendientesPostventa } from '../src/modules/vuelos/operaciones/pendientes-postventa';
import { EmisionPendiente } from '../src/modules/vuelos/operaciones/reserva/emision-pendiente';
import { PrismaService } from '../src/prisma/prisma.service';
import { desactivarUsuariosDePrueba, firmarToken } from './utils/auth';
import { CadenaBusqueda, crearCadena, darDeBajaCadena, fechaEn } from './utils/busqueda';
import { ADMIN, AppCatalogo, codigos, crearAppCatalogo } from './utils/catalogo';
import { erroresContraContrato } from './utils/contrato';
import { crearApp } from './utils/crear-app';
import { LimitesReiniciables } from './utils/limites';
import { agregarSalida, cancelarReservasDe, estadoEnBase } from './utils/postventa';
import { esperarProblemDetails } from './utils/problem-details';
import { RelojDePrueba } from './utils/reloj';
import {
  buscarYRetener,
  con,
  cuerpoReserva,
  cupoDe,
  nuevoCliente,
  pasajero,
  referenciaPago,
  reservar,
  RESERVAS,
} from './utils/reserva';

type Cliente = { id: string; token: string };
type Cuerpo = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- se valida con Ajv

const esperarContrato = (esquema: string, cuerpo: unknown) =>
  expect(erroresContraContrato(esquema, cuerpo)).toEqual([]);

const centavos = (texto: string) => Math.round(Number(texto) * 100);

/** Una reserva confirmada (o pendiente) de UIO-GYE directo en la semilla. */
async function reservaSemilla(
  app: INestApplication,
  cliente: Cliente,
  dias: number,
  opciones: { fareBrand?: string; pasajeros?: object[]; referencia?: string } = {},
): Promise<{ id: string; detalle: Cuerpo; salida: string; itinerario: string }> {
  const pasajeros = opciones.pasajeros ?? [pasajero('ADULT', 1)];
  const breakdown = {
    adults: pasajeros.filter((p) => (p as { passengerType: string }).passengerType === 'ADULT')
      .length,
    infants: pasajeros.filter((p) => (p as { passengerType: string }).passengerType === 'INFANT')
      .length,
  };
  const retenido = await buscarYRetener(
    app,
    cliente.token,
    [['UIO', 'GYE', fechaEn(dias)]],
    breakdown,
    {
      directa: true,
      fareBrand: opciones.fareBrand,
    },
  );
  const respuesta = await reservar(
    app,
    cliente.token,
    cuerpoReserva(retenido.holdId, pasajeros, opciones.referencia ?? referenciaPago()),
  );
  expect([201, 202]).toContain(respuesta.status);
  return {
    id: respuesta.body.bookingId,
    detalle: respuesta.body,
    salida: retenido.oferta.itineraries[0].segments[0].segmentId,
    itinerario: retenido.oferta.itineraries[0].itineraryId,
  };
}

const comprar = (
  app: INestApplication,
  cliente: Cliente,
  reservaId: string,
  cuerpo: object,
  clave: string | null = randomUUID(),
) => {
  const prueba = con(app, cliente.token)('post', `${RESERVAS}/${reservaId}/baggage`);
  return (clave === null ? prueba : prueba.set('Idempotency-Key', clave)).send(cuerpo);
};

const cotizar = (app: INestApplication, cliente: Cliente, reservaId: string) =>
  con(app, cliente.token)('get', `${RESERVAS}/${reservaId}/cancellation-quote`);

const cancelar = (
  app: INestApplication,
  cliente: Cliente,
  reservaId: string,
  cuerpo: object,
  clave = randomUUID(),
) =>
  con(app, cliente.token)('post', `${RESERVAS}/${reservaId}/cancel`)
    .set('Idempotency-Key', clave)
    .send(cuerpo);

const buscarCambio = (
  app: INestApplication,
  cliente: Cliente,
  reservaId: string,
  cambios: object[],
) =>
  con(app, cliente.token)('post', `${RESERVAS}/${reservaId}/date-change/search`).send({
    changes: cambios,
  });

const confirmarCambio = (
  app: INestApplication,
  cliente: Cliente,
  reservaId: string,
  cuerpo: object,
  clave = randomUUID(),
) =>
  con(app, cliente.token)('post', `${RESERVAS}/${reservaId}/date-change`)
    .set('Idempotency-Key', clave)
    .send(cuerpo);

describe('Equipaje adicional sobre la semilla', () => {
  const reloj = new RelojDePrueba();
  const limites = new LimitesReiniciables();
  let app: INestApplication;
  let prisma: PrismaService;
  let cliente: Cliente;
  let otro: Cliente;

  beforeAll(async () => {
    app = await crearApp([], { reloj, limites });
    prisma = app.get(PrismaService);
    cliente = await nuevoCliente(app);
    otro = await nuevoCliente(app);
  });
  beforeEach(() => {
    reloj.alPresente();
    limites.reiniciar();
  });
  afterAll(async () => {
    await desactivarUsuariosDePrueba(app);
    await app.close();
  });

  describe('opciones y compra', () => {
    let reserva: Awaited<ReturnType<typeof reservaSemilla>>;
    let precio: string;
    const adulto = pasajero('ADULT', 1);
    const cuerpo = (
      cantidad: number,
      referencia = referenciaPago(),
      quien = adulto.passengerId,
    ) => ({
      passengerId: quien,
      itineraryId: reserva.itinerario,
      quantity: cantidad,
      payment: { paymentReference: referencia },
    });

    beforeAll(async () => {
      reloj.alPresente();
      reserva = await reservaSemilla(app, cliente, 55, {
        fareBrand: 'CLASSIC',
        pasajeros: [adulto, pasajero('INFANT', 2, { associatedAdultId: adulto.passengerId })],
      });
      precio = reserva.detalle.itineraries[0].pricingOptions[0].extraCheckedBaggagePrice.total;
    });

    it('opciones: BaggageOptionsResponse con el precio de la tarifa, el máximo de la familia y 0 para el infante', async () => {
      const respuesta = await con(app, cliente.token)(
        'get',
        `${RESERVAS}/${reserva.id}/baggage-options`,
      ).expect(200);
      esperarContrato('BaggageOptionsResponse', respuesta.body);
      expect(respuesta.body).toEqual([
        {
          passengerId: 'ADU1',
          itineraryId: reserva.itinerario,
          price: { currency: 'USD', total: precio },
          maxAllowed: 2,
          alreadyPurchased: 0,
        },
        {
          passengerId: 'INF2',
          itineraryId: reserva.itinerario,
          price: { currency: 'USD', total: precio },
          maxAllowed: 0,
          alreadyPurchased: 0,
        },
      ]);
    });

    it('compra aprobada: 200 BaggageAddedResponse, suma al total, al historial y a las opciones', async () => {
      const antes = reserva.detalle.grandTotal.total;
      const respuesta = await comprar(app, cliente, reserva.id, cuerpo(1)).expect(200);
      esperarContrato('BaggageAddedResponse', respuesta.body);
      expect(respuesta.body).toEqual({
        passengerId: 'ADU1',
        itineraryId: reserva.itinerario,
        totalBaggage: 1,
      });
      const detalle = await con(app, cliente.token)('get', `${RESERVAS}/${reserva.id}`).expect(200);
      expect(centavos(detalle.body.grandTotal.total)).toBe(centavos(antes) + centavos(precio));
      expect(detalle.body.passengers[0].extraBaggage).toEqual([
        { itineraryId: reserva.itinerario, quantity: 1 },
      ]);
      expect(detalle.body.changes.at(-1).description).toBe(
        '1 extra bag(s) added for passenger ADU1',
      );
      const opciones = await con(app, cliente.token)(
        'get',
        `${RESERVAS}/${reserva.id}/baggage-options`,
      ).expect(200);
      expect(opciones.body[0].alreadyPurchased).toBe(1);
    });

    it('la misma clave con el mismo cuerpo repite el resultado sin cobrar ni sumar otra vez; con otro cuerpo, 422', async () => {
      const clave = randomUUID();
      const c = cuerpo(1);
      const primera = await comprar(app, cliente, reserva.id, c, clave).expect(200);
      const segunda = await comprar(app, cliente, reserva.id, c, clave).expect(200);
      expect(segunda.headers['idempotent-replayed']).toBe('true');
      expect(segunda.body).toEqual(primera.body);
      expect((await estadoEnBase(prisma, reserva.id)).maletas).toBe(2);
      const otroCuerpo = await comprar(app, cliente, reserva.id, cuerpo(2), clave);
      expect(otroCuerpo.status).toBe(422);
      esperarProblemDetails(otroCuerpo);
    });

    it('pasar el máximo: 409 BAGGAGE_LIMIT_EXCEEDED; el infante no compra', async () => {
      const respuesta = await comprar(app, cliente, reserva.id, cuerpo(1));
      expect(respuesta.status).toBe(409);
      esperarProblemDetails(respuesta);
      expect(respuesta.body.code).toBe('BAGGAGE_LIMIT_EXCEEDED');
      const infante = await comprar(app, cliente, reserva.id, cuerpo(1, referenciaPago(), 'INF2'));
      expect(infante.status).toBe(409);
      expect(infante.body.code).toBe('BAGGAGE_LIMIT_EXCEEDED');
    });

    it.each([
      ['un pasajero que no es de la reserva', { passengerId: 'NADIE' }, 422, 'passengerId'],
      ['un itinerario que no es de la reserva', { itineraryId: randomUUID() }, 422, 'itineraryId'],
      ['cantidad 0', { quantity: 0 }, 400, 'quantity'],
      ['sin pago', { payment: undefined }, 400, 'payment'],
    ])('%s', async (_caso, cambio, status, campo) => {
      const respuesta = await comprar(app, cliente, reserva.id, { ...cuerpo(1), ...cambio });
      expect(respuesta.status).toBe(status);
      expect(respuesta.body.invalidParams.map((p: { name: string }) => p.name)).toContain(campo);
    });

    it('la reserva de otro usuario no existe para él (404)', async () => {
      expect(
        (await con(app, otro.token)('get', `${RESERVAS}/${reserva.id}/baggage-options`)).status,
      ).toBe(404);
      expect((await comprar(app, otro, reserva.id, cuerpo(1))).status).toBe(404);
    });

    it('un vuelo que ya salió: 409 FLIGHT_ALREADY_DEPARTED', async () => {
      reloj.adelantar(60 * 24 * 60);
      const respuesta = await comprar(app, cliente, reserva.id, cuerpo(1));
      expect(respuesta.status).toBe(409);
      expect(respuesta.body.code).toBe('FLIGHT_ALREADY_DEPARTED');
    });
  });

  describe('pagos', () => {
    let reserva: Awaited<ReturnType<typeof reservaSemilla>>;
    const cuerpo = (cantidad: number, referencia: string) => ({
      passengerId: 'ADU1',
      itineraryId: reserva.itinerario,
      quantity: cantidad,
      payment: { paymentReference: referencia },
    });
    beforeAll(async () => {
      reloj.alPresente();
      reserva = await reservaSemilla(app, cliente, 56, { fareBrand: 'FLEX' });
    });

    it('rechazado o inválido: 422 sin cambios; una referencia ya usada: 409', async () => {
      const rechazado = await comprar(app, cliente, reserva.id, cuerpo(1, referenciaPago('REJ')));
      expect(rechazado.status).toBe(422);
      expect(rechazado.body.code).toBe('PAYMENT_NOT_AUTHORIZED');
      const invalido = await comprar(app, cliente, reserva.id, cuerpo(1, 'NO-ES-PAGO-123'));
      expect(invalido.body.code).toBe('PAYMENT_REFERENCE_INVALID');
      expect((await estadoEnBase(prisma, reserva.id)).maletas).toBe(0);
      const referencia = referenciaPago();
      await comprar(app, cliente, reserva.id, cuerpo(1, referencia)).expect(200);
      const usada = await comprar(app, cliente, reserva.id, cuerpo(1, referencia));
      expect(usada.status).toBe(409);
      expect(usada.body.code).toBe('PAYMENT_REFERENCE_INVALID');
    });

    it('pendiente: 202, la maleta ya cuenta para el máximo; el proceso confirma el pago y suma al total', async () => {
      const antes = await con(app, cliente.token)('get', `${RESERVAS}/${reserva.id}`).expect(200);
      const respuesta = await comprar(app, cliente, reserva.id, cuerpo(2, referenciaPago('PEND')));
      expect(respuesta.status).toBe(202);
      esperarContrato('BaggageAddedResponse', respuesta.body);
      expect(respuesta.body.totalBaggage).toBe(3);
      // FLEX admite 3: con la pendiente ya no cabe otra
      expect((await comprar(app, cliente, reserva.id, cuerpo(1, referenciaPago()))).status).toBe(
        409,
      );
      const pendiente = await con(app, cliente.token)('get', `${RESERVAS}/${reserva.id}`).expect(
        200,
      );
      expect(pendiente.body.grandTotal.total).toBe(antes.body.grandTotal.total);

      expect((await app.get(PendientesPostventa).ejecutar()).equipaje).toBeGreaterThanOrEqual(1);
      const despues = await con(app, cliente.token)('get', `${RESERVAS}/${reserva.id}`).expect(200);
      const precio =
        reserva.detalle.itineraries[0].pricingOptions[0].extraCheckedBaggagePrice.total;
      expect(centavos(despues.body.grandTotal.total)).toBe(
        centavos(antes.body.grandTotal.total) + 2 * centavos(precio),
      );
      expect(despues.body.changes.at(-1).description).toBe(
        '2 extra bag(s) added for passenger ADU1',
      );
    });
  });

  it('concurrencia: la misma clave suma una vez; claves distintas no pasan el máximo', async () => {
    const reserva = await reservaSemilla(app, cliente, 57, { fareBrand: 'CLASSIC' });
    const cuerpo = (referencia: string) => ({
      passengerId: 'ADU1',
      itineraryId: reserva.itinerario,
      quantity: 1,
      payment: { paymentReference: referencia },
    });
    const clave = randomUUID();
    const mismo = cuerpo(referenciaPago());
    const misma = await Promise.all(
      [1, 2, 3].map(() => comprar(app, cliente, reserva.id, mismo, clave)),
    );
    expect(misma.map((r) => r.status)).toEqual([200, 200, 200]);
    expect((await estadoEnBase(prisma, reserva.id)).maletas).toBe(1);

    // CLASSIC admite 2: queda 1; tres compras distintas a la vez, gana una
    const distintas = await Promise.all(
      [1, 2, 3].map(() => comprar(app, cliente, reserva.id, cuerpo(referenciaPago()))),
    );
    expect(distintas.filter((r) => r.status === 200)).toHaveLength(1);
    expect(distintas.filter((r) => r.status === 409).map((r) => r.body.code)).toEqual([
      'BAGGAGE_LIMIT_EXCEEDED',
      'BAGGAGE_LIMIT_EXCEEDED',
    ]);
    expect((await estadoEnBase(prisma, reserva.id)).maletas).toBe(2);
  });
});

describe('Cancelación sobre la semilla', () => {
  const reloj = new RelojDePrueba();
  const limites = new LimitesReiniciables();
  let app: INestApplication;
  let prisma: PrismaService;
  let cliente: Cliente;
  let otro: Cliente;

  beforeAll(async () => {
    app = await crearApp([], { reloj, limites });
    prisma = app.get(PrismaService);
    cliente = await nuevoCliente(app);
    otro = await nuevoCliente(app);
  });
  beforeEach(() => {
    reloj.alPresente();
    limites.reiniciar();
  });
  afterAll(async () => {
    await desactivarUsuariosDePrueba(app);
    await app.close();
  });

  it('cotización: CancellationQuoteResponse con la penalidad de la familia (CLASSIC retiene 35 %)', async () => {
    const reserva = await reservaSemilla(app, cliente, 60, { fareBrand: 'CLASSIC' });
    const respuesta = await cotizar(app, cliente, reserva.id).expect(200);
    esperarContrato('CancellationQuoteResponse', respuesta.body);
    const total = centavos(reserva.detalle.grandTotal.total);
    const reembolso = Math.round((total * 65) / 100);
    expect(respuesta.body).toMatchObject({
      isRefundable: true,
      currency: 'USD',
      refundAmount: (reembolso / 100).toFixed(2),
      penaltyAmount: ((total - reembolso) / 100).toFixed(2),
    });
    expect(new Date(respuesta.body.expiresAt).getTime()).toBe(
      reloj.ahora().getTime() + 15 * 60_000,
    );
  });

  it('BASIC no reembolsa: isRefundable false; cancelar deja los boletos VOIDED y responde 200', async () => {
    const reserva = await reservaSemilla(app, cliente, 61, { fareBrand: 'BASIC' });
    const cotizacion = await cotizar(app, cliente, reserva.id).expect(200);
    expect(cotizacion.body).toMatchObject({ isRefundable: false, refundAmount: '0.00' });
    const respuesta = await cancelar(app, cliente, reserva.id, {
      quoteId: cotizacion.body.quoteId,
    }).expect(200);
    expect(respuesta.body.status).toBe('CANCELLED');
    expect(respuesta.body.tickets.map((t: { status: string }) => t.status)).toEqual(['VOIDED']);
  });

  describe('cancelar con reembolso aprobado', () => {
    let reserva: Awaited<ReturnType<typeof reservaSemilla>>;
    let quoteId: string;
    let antes: Awaited<ReturnType<typeof cupoDe>>;
    const clave = randomUUID();
    let respuesta: Cuerpo;

    beforeAll(async () => {
      reloj.alPresente();
      limites.reiniciar();
      reserva = await reservaSemilla(app, cliente, 62, { fareBrand: 'CLASSIC' });
      antes = await cupoDe(prisma, reserva.salida);
      quoteId = (await cotizar(app, cliente, reserva.id).expect(200)).body.quoteId;
      respuesta = (
        await cancelar(
          app,
          cliente,
          reserva.id,
          { quoteId, reason: 'Cambio de planes' },
          clave,
        ).expect(200)
      ).body;
    });

    it('200 con la reserva CANCELLED, boletos REFUNDED y el historial', () => {
      esperarContrato('BookingDetail', respuesta);
      expect(respuesta.status).toBe('CANCELLED');
      expect(respuesta.tickets.map((t: { status: string }) => t.status)).toEqual(['REFUNDED']);
      expect(respuesta.passengers[0].assignedSeats).toEqual([]);
      expect(
        respuesta.changes.slice(-2).map((c: { description: string }) => c.description),
      ).toEqual([
        expect.stringMatching(/^Cancellation accepted; refund of/),
        expect.stringMatching(/^Booking cancelled; .* refunded$/),
      ]);
    });

    it('el cupo vuelve y los asientos quedan libres en la base', async () => {
      const despues = await cupoDe(prisma, reserva.salida);
      expect(despues.disponibles).toBe(antes.disponibles + 1);
      expect(await estadoEnBase(prisma, reserva.id)).toMatchObject({
        estado: 'CANCELADA',
        asientos: 0,
        boletos: 'REEMBOLSADO',
      });
      const cotizacion = await prisma.db.cotizacion_cancelacion.findUniqueOrThrow({
        where: { id: quoteId },
      });
      expect(cotizacion.fecha_aceptacion).not.toBeNull();
      expect(cotizacion.fecha_completada).not.toBeNull();
      expect(cotizacion.motivo).toBe('Cambio de planes');
    });

    it('la misma clave repite el resultado; otra clave, 409 ALREADY_CANCELLED; cotizar otra vez, 409', async () => {
      const repetida = await cancelar(
        app,
        cliente,
        reserva.id,
        { quoteId, reason: 'Cambio de planes' },
        clave,
      ).expect(200);
      expect(repetida.headers['idempotent-replayed']).toBe('true');
      expect(repetida.body.status).toBe('CANCELLED');
      const otraClave = await cancelar(app, cliente, reserva.id, { quoteId });
      expect(otraClave.status).toBe(409);
      esperarProblemDetails(otraClave);
      expect(otraClave.body.code).toBe('ALREADY_CANCELLED');
      expect((await cotizar(app, cliente, reserva.id)).status).toBe(409);
      expect((await cupoDe(prisma, reserva.salida)).disponibles).toBe(antes.disponibles + 1);
    });
  });

  it('cotización vencida: 409 QUOTE_EXPIRED; de otra reserva o inexistente: 422; reserva ajena: 404', async () => {
    const reserva = await reservaSemilla(app, cliente, 63, { fareBrand: 'CLASSIC' });
    const otraReserva = await reservaSemilla(app, cliente, 63, { fareBrand: 'CLASSIC' });
    const quoteId = (await cotizar(app, cliente, reserva.id).expect(200)).body.quoteId;
    const ajena = (await cotizar(app, cliente, otraReserva.id).expect(200)).body.quoteId;
    for (const id of [ajena, randomUUID()]) {
      const r = await cancelar(app, cliente, reserva.id, { quoteId: id });
      expect(r.status).toBe(422);
      expect(r.body.invalidParams[0].name).toBe('quoteId');
    }
    expect((await cotizar(app, otro, reserva.id)).status).toBe(404);
    expect((await cancelar(app, otro, reserva.id, { quoteId })).status).toBe(404);
    reloj.adelantar(16);
    const vencida = await cancelar(app, cliente, reserva.id, { quoteId });
    expect(vencida.status).toBe(409);
    expect(vencida.body.code).toBe('QUOTE_EXPIRED');
    expect((await estadoEnBase(prisma, reserva.id)).estado).toBe('CONFIRMADA');
    // El proceso borra las cotizaciones vencidas que nadie aceptó
    expect((await app.get(PendientesPostventa).ejecutar()).purgadas).toBeGreaterThanOrEqual(1);
    expect(await prisma.db.cotizacion_cancelacion.count({ where: { id: quoteId } })).toBe(0);
  });

  it('un vuelo que ya salió: 409; una maleta con pago pendiente: 409 hasta que se resuelve', async () => {
    const reserva = await reservaSemilla(app, cliente, 64, { fareBrand: 'CLASSIC' });
    await comprar(app, cliente, reserva.id, {
      passengerId: 'ADU1',
      itineraryId: reserva.itinerario,
      quantity: 1,
      payment: { paymentReference: referenciaPago('PEND') },
    }).expect(202);
    const pendiente = await cotizar(app, cliente, reserva.id);
    expect(pendiente.status).toBe(409);
    expect(pendiente.body.detail).toMatch(/payment pending/);
    await app.get(PendientesPostventa).ejecutar();
    await cotizar(app, cliente, reserva.id).expect(200);
    reloj.adelantar(70 * 24 * 60);
    const despego = await cotizar(app, cliente, reserva.id);
    expect(despego.status).toBe(409);
    expect(despego.body.code).toBe('FLIGHT_ALREADY_DEPARTED');
  });

  it('reembolso pendiente: 202 CANCELLATION_PENDING; el proceso la deja CANCELLED', async () => {
    const reserva = await reservaSemilla(app, cliente, 65, {
      fareBrand: 'CLASSIC',
      referencia: referenciaPago('PEND'),
    });
    await app.get(EmisionPendiente).ejecutar();
    const quoteId = (await cotizar(app, cliente, reserva.id).expect(200)).body.quoteId;
    const respuesta = await cancelar(app, cliente, reserva.id, { quoteId });
    expect(respuesta.status).toBe(202);
    esperarContrato('BookingDetail', respuesta.body);
    expect(respuesta.body.status).toBe('CANCELLATION_PENDING');
    expect(respuesta.body.tickets.map((t: { status: string }) => t.status)).toEqual(['VOIDED']);
    expect((await app.get(PendientesPostventa).ejecutar()).cancelaciones).toBeGreaterThanOrEqual(1);
    const detalle = await con(app, cliente.token)('get', `${RESERVAS}/${reserva.id}`).expect(200);
    expect(detalle.body.status).toBe('CANCELLED');
    expect(detalle.body.tickets.map((t: { status: string }) => t.status)).toEqual(['REFUNDED']);
  });

  it('concurrencia: dos cancelaciones a la vez cancelan una vez y el cupo vuelve una vez', async () => {
    const reserva = await reservaSemilla(app, cliente, 66, { fareBrand: 'CLASSIC' });
    const antes = await cupoDe(prisma, reserva.salida);
    const quoteId = (await cotizar(app, cliente, reserva.id).expect(200)).body.quoteId;
    const respuestas = await Promise.all(
      [1, 2, 3].map(() => cancelar(app, cliente, reserva.id, { quoteId })),
    );
    expect(respuestas.filter((r) => r.status === 200)).toHaveLength(1);
    expect(
      respuestas
        .filter((r) => r.status === 409)
        .map((r) => r.body.code)
        .sort(),
    ).toEqual(expect.arrayContaining(['ALREADY_CANCELLED']));
    expect((await cupoDe(prisma, reserva.salida)).disponibles).toBe(antes.disponibles + 1);
    expect(
      await prisma.db.cotizacion_cancelacion.count({
        where: { reserva_id: reserva.id, fecha_aceptacion: { not: null } },
      }),
    ).toBe(1);
  });
});

describe('Cambio de fecha sobre un catálogo propio', () => {
  const reloj = new RelojDePrueba();
  const limites = new LimitesReiniciables();
  let c: AppCatalogo;
  let k: CadenaBusqueda;
  let cliente: Cliente;
  let otro: Cliente;
  let nueva: { salida: string; fecha: string };
  let ultima: { salida: string; fecha: string };

  /**
   * El mapa de la cadena tiene 6 asientos de económica: cada prueba suelta cancela al terminar
   * sus reservas confirmadas (y las que cambió), así el cupo y los asientos vuelven.
   */
  const limpiar = async () => {
    for (const quien of [cliente, otro]) await cancelarReservasDe(c.app, quien.token);
  };

  /** Una reserva confirmada de la cadena (salida del día 20, BUSCA a 60.30 por adulto). */
  async function reservaCadena(quien: Cliente, referencia = referenciaPago()) {
    const retenido = await buscarYRetener(c.app, quien.token, [[k.origen, k.destino, k.fecha]], {
      adults: 1,
    });
    const r = await reservar(
      c.app,
      quien.token,
      cuerpoReserva(retenido.holdId, [pasajero('ADULT', 1)], referencia),
    ).expect(201);
    return {
      id: r.body.bookingId as string,
      itinerario: retenido.oferta.itineraries[0].itineraryId,
      detalle: r.body,
    };
  }

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
    ultima = await agregarSalida(c, k, 24, 1, { baseFare: '40.00', taxes: '8.00' });
    cliente = await nuevoCliente(c.app);
    otro = await nuevoCliente(c.app);
  });
  beforeEach(() => {
    reloj.alPresente();
    limites.reiniciar();
  });
  afterAll(async () => {
    await limpiar();
    for (const salida of [nueva.salida, ultima.salida]) {
      await c.admin('delete', `${ADMIN}/departures/${salida}`).expect(204);
    }
    await c.admin('patch', `${ADMIN}/airlines/${k.aerolinea}`, { ticketPrefix: null }).expect(200);
    await darDeBajaCadena(c, k);
    await desactivarUsuariosDePrueba(c.app);
    await c.cerrar();
  });

  it('buscar: DateChangeSearchResponse con la diferencia (tarifa, impuestos, cargo por pasajero y total)', async () => {
    const reserva = await reservaCadena(cliente);
    const respuesta = await buscarCambio(c.app, cliente, reserva.id, [
      { itineraryId: reserva.itinerario, newDepartureDate: nueva.fecha },
    ]).expect(200);
    esperarContrato('DateChangeSearchResponse', respuesta.body);
    expect(respuesta.body).toHaveLength(1);
    const [opcion] = respuesta.body;
    expect(opcion.segments.map((s: { segmentId: string }) => s.segmentId)).toEqual([nueva.salida]);
    // 70.00 − 50.10 = 19.90; 14.00 − 10.20 = 3.80; cargo 5.00 × 1 pasajero
    expect(opcion.priceDifference).toEqual({
      fareDifference: '19.90',
      taxDifference: '3.80',
      changeFee: '5.00',
      totalToPay: '28.70',
    });
    expect(new Date(opcion.expiresAt).getTime()).toBe(reloj.ahora().getTime() + 15 * 60_000);
    // Más barata: lo que baja no se devuelve, el cargo sí se cobra
    const barata = await buscarCambio(c.app, cliente, reserva.id, [
      { itineraryId: reserva.itinerario, newDepartureDate: ultima.fecha },
    ]).expect(200);
    expect(barata.body[0].priceDifference).toEqual({
      fareDifference: '-10.10',
      taxDifference: '-2.20',
      changeFee: '5.00',
      totalToPay: '5.00',
    });
    await limpiar();
  });

  it.each([
    ['una fecha pasada', () => '2020-01-01', 400],
    ['un itinerario que no es de la reserva', () => 'otro', 422],
  ])('buscar con %s', async (_caso, fecha, status) => {
    const reserva = await reservaCadena(cliente);
    const cuerpo =
      fecha() === 'otro'
        ? [{ itineraryId: randomUUID(), newDepartureDate: nueva.fecha }]
        : [{ itineraryId: reserva.itinerario, newDepartureDate: fecha() }];
    const respuesta = await buscarCambio(c.app, cliente, reserva.id, cuerpo);
    expect(respuesta.status).toBe(status);
    esperarProblemDetails(respuesta);
    await limpiar();
  });

  describe('confirmar con pago aprobado', () => {
    let reserva: Awaited<ReturnType<typeof reservaCadena>>;
    let respuesta: Cuerpo;
    let oferta: string;
    const clave = randomUUID();
    let cuerpo: object;
    let antes: { vieja: number; nueva: number };

    beforeAll(async () => {
      reloj.alPresente();
      limites.reiniciar();
      reserva = await reservaCadena(cliente);
      oferta = (
        await buscarCambio(c.app, cliente, reserva.id, [
          { itineraryId: reserva.itinerario, newDepartureDate: nueva.fecha },
        ]).expect(200)
      ).body[0].changeOfferId;
      antes = {
        vieja: (await cupoDe(c.prisma, k.salida)).disponibles,
        nueva: (await cupoDe(c.prisma, nueva.salida)).disponibles,
      };
      cuerpo = {
        changeOfferId: oferta,
        payment: { paymentReference: referenciaPago() },
        assignedSeats: [{ segmentId: nueva.salida, seatNumber: '3C' }],
      };
      respuesta = (await confirmarCambio(c.app, cliente, reserva.id, cuerpo, clave).expect(200))
        .body;
    });

    it('200 BookingDetail con el itinerario nuevo, el asiento pedido y el total con la diferencia y el cargo', () => {
      esperarContrato('BookingDetail', respuesta);
      expect(respuesta.status).toBe('CONFIRMED');
      expect(
        respuesta.itineraries[0].segments.map((s: { segmentId: string }) => s.segmentId),
      ).toEqual([nueva.salida]);
      expect(respuesta.passengers[0].assignedSeats).toEqual([
        { segmentId: nueva.salida, seatNumber: '3C' },
      ]);
      expect(respuesta.grandTotal.total).toBe('89.00'); // 60.30 + 28.70
      expect(respuesta.changes.at(-1).description).toBe(
        'Date changed for 1 itinerary(ies); 28.70 charged',
      );
    });

    it('boletos: el viejo VOIDED y uno nuevo ISSUED con el cupón del vuelo nuevo', () => {
      const porEstado = Object.fromEntries(
        respuesta.tickets.map((t: { status: string }) => [t.status, t]),
      );
      expect(Object.keys(porEstado).sort()).toEqual(['ISSUED', 'VOIDED']);
      expect(porEstado.ISSUED.segments).toEqual([
        { segmentId: nueva.salida, status: 'ISSUED', couponNumber: '1' },
      ]);
      expect(porEstado.VOIDED.segments[0].segmentId).toBe(k.salida);
    });

    it('el cupo pasa del vuelo viejo al nuevo y los asientos cuadran en la base', async () => {
      expect((await cupoDe(c.prisma, k.salida)).disponibles).toBe(antes.vieja + 1);
      expect((await cupoDe(c.prisma, nueva.salida)).disponibles).toBe(antes.nueva - 1);
      expect(await estadoEnBase(c.prisma, reserva.id)).toMatchObject({
        estado: 'CONFIRMADA',
        lineas: 1,
        asientos: 1,
        boletos: 'ANULADO,EMITIDO',
      });
    });

    it('la misma clave repite; la misma oferta con otra clave, 409; sin cambios en el cupo', async () => {
      const repetida = await confirmarCambio(c.app, cliente, reserva.id, cuerpo, clave).expect(200);
      expect(repetida.headers['idempotent-replayed']).toBe('true');
      const otraClave = await confirmarCambio(c.app, cliente, reserva.id, {
        ...cuerpo,
        payment: { paymentReference: referenciaPago() },
      });
      expect(otraClave.status).toBe(409);
      esperarProblemDetails(otraClave);
      expect((await cupoDe(c.prisma, nueva.salida)).disponibles).toBe(antes.nueva - 1);
    });
  });

  it('oferta vencida: 410 CHANGE_OFFER_EXPIRED; de otra reserva: 422; sin payment: 422; rechazado: 422 sin cambios', async () => {
    const reserva = await reservaCadena(cliente);
    const otraReserva = await reservaCadena(cliente);
    const oferta = (
      await buscarCambio(c.app, cliente, reserva.id, [
        { itineraryId: reserva.itinerario, newDepartureDate: nueva.fecha },
      ]).expect(200)
    ).body[0].changeOfferId;
    const ajena = (
      await buscarCambio(c.app, cliente, otraReserva.id, [
        { itineraryId: otraReserva.itinerario, newDepartureDate: nueva.fecha },
      ]).expect(200)
    ).body[0].changeOfferId;
    expect(
      (
        await confirmarCambio(c.app, cliente, reserva.id, {
          changeOfferId: ajena,
          payment: { paymentReference: referenciaPago() },
        })
      ).status,
    ).toBe(422);
    const sinPago = await confirmarCambio(c.app, cliente, reserva.id, { changeOfferId: oferta });
    expect(sinPago.status).toBe(422);
    expect(sinPago.body.invalidParams[0].name).toBe('payment');
    const rechazado = await confirmarCambio(c.app, cliente, reserva.id, {
      changeOfferId: oferta,
      payment: { paymentReference: referenciaPago('REJ') },
    });
    expect(rechazado.status).toBe(422);
    expect(rechazado.body.code).toBe('PAYMENT_NOT_AUTHORIZED');
    expect(await estadoEnBase(c.prisma, reserva.id)).toMatchObject({
      estado: 'CONFIRMADA',
      boletos: 'EMITIDO',
    });
    expect((await confirmarCambio(c.app, otro, reserva.id, { changeOfferId: oferta })).status).toBe(
      404,
    );
    reloj.adelantar(16);
    const vencida = await confirmarCambio(c.app, cliente, reserva.id, {
      changeOfferId: oferta,
      payment: { paymentReference: referenciaPago() },
    });
    expect(vencida.status).toBe(410);
    esperarProblemDetails(vencida);
    expect(vencida.body.code).toBe('CHANGE_OFFER_EXPIRED');
    await limpiar();
  });

  it('un asiento de otra cabina: 422 SEAT_CABIN_MISMATCH y no cambia nada', async () => {
    const reserva = await reservaCadena(cliente);
    const oferta = (
      await buscarCambio(c.app, cliente, reserva.id, [
        { itineraryId: reserva.itinerario, newDepartureDate: nueva.fecha },
      ]).expect(200)
    ).body[0].changeOfferId;
    const respuesta = await confirmarCambio(c.app, cliente, reserva.id, {
      changeOfferId: oferta,
      payment: { paymentReference: referenciaPago() },
      assignedSeats: [{ segmentId: nueva.salida, seatNumber: '1A' }],
    });
    expect(respuesta.status).toBe(422);
    expect(respuesta.body.code).toBe('SEAT_CABIN_MISMATCH');
    expect(
      await c.prisma.db.cambio_cabecera.findUniqueOrThrow({ where: { id: oferta } }),
    ).toMatchObject({ estado: 'OFERTADO' });
    await limpiar();
  });

  it('pago pendiente: 202 CHANGE_PENDING con los vuelos nuevos tomados; el proceso aplica el cambio', async () => {
    const reserva = await reservaCadena(cliente);
    const oferta = (
      await buscarCambio(c.app, cliente, reserva.id, [
        { itineraryId: reserva.itinerario, newDepartureDate: nueva.fecha },
      ]).expect(200)
    ).body[0].changeOfferId;
    const antes = {
      vieja: (await cupoDe(c.prisma, k.salida)).disponibles,
      nueva: (await cupoDe(c.prisma, nueva.salida)).disponibles,
    };
    const respuesta = await confirmarCambio(c.app, cliente, reserva.id, {
      changeOfferId: oferta,
      payment: { paymentReference: referenciaPago('PEND') },
    });
    expect(respuesta.status).toBe(202);
    esperarContrato('BookingDetail', respuesta.body);
    expect(respuesta.body.status).toBe('CHANGE_PENDING');
    expect(respuesta.body.itineraries[0].segments[0].segmentId).toBe(k.salida);
    expect((await cupoDe(c.prisma, nueva.salida)).disponibles).toBe(antes.nueva - 1);
    expect((await cupoDe(c.prisma, k.salida)).disponibles).toBe(antes.vieja);
    expect((await cotizar(c.app, cliente, reserva.id)).status).toBe(409);

    expect((await c.app.get(PendientesPostventa).ejecutar()).cambios).toBeGreaterThanOrEqual(1);
    const detalle = await con(c.app, cliente.token)('get', `${RESERVAS}/${reserva.id}`).expect(200);
    expect(detalle.body.status).toBe('CONFIRMED');
    expect(detalle.body.itineraries[0].segments[0].segmentId).toBe(nueva.salida);
    expect((await cupoDe(c.prisma, k.salida)).disponibles).toBe(antes.vieja + 1);
    expect(await estadoEnBase(c.prisma, reserva.id)).toMatchObject({
      lineas: 1,
      asientos: 1,
      boletos: 'ANULADO,EMITIDO',
    });
    await limpiar();
  });

  it('una familia que no admite cambios: 409 FARE_NOT_CHANGEABLE', async () => {
    const reserva = await reservaCadena(cliente);
    await c
      .admin('patch', `${ADMIN}/fare-families/${k.familia}`, { changeable: false })
      .expect(200);
    try {
      const respuesta = await buscarCambio(c.app, cliente, reserva.id, [
        { itineraryId: reserva.itinerario, newDepartureDate: nueva.fecha },
      ]);
      expect(respuesta.status).toBe(409);
      expect(respuesta.body.code).toBe('FARE_NOT_CHANGEABLE');
    } finally {
      await c
        .admin('patch', `${ADMIN}/fare-families/${k.familia}`, { changeable: true })
        .expect(200);
    }
    await limpiar();
  });

  it('concurrencia: dos cambios por el último cupo, exactamente uno gana y el cupo no baja de 0', async () => {
    const [una, dos] = [await reservaCadena(cliente), await reservaCadena(otro)];
    const ofertaDe = async (quien: Cliente, r: typeof una) =>
      (
        await buscarCambio(c.app, quien, r.id, [
          { itineraryId: r.itinerario, newDepartureDate: ultima.fecha },
        ]).expect(200)
      ).body[0].changeOfferId;
    const ofertas = [await ofertaDe(cliente, una), await ofertaDe(otro, dos)];
    const respuestas = await Promise.all([
      confirmarCambio(c.app, cliente, una.id, {
        changeOfferId: ofertas[0],
        payment: { paymentReference: referenciaPago() },
      }),
      confirmarCambio(c.app, otro, dos.id, {
        changeOfferId: ofertas[1],
        payment: { paymentReference: referenciaPago() },
      }),
    ]);
    expect(respuestas.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(respuestas.find((r) => r.status === 409)!.body.code).toBe('OFFER_NO_LONGER_AVAILABLE');
    expect(await cupoDe(c.prisma, ultima.salida)).toMatchObject({ totales: 1, disponibles: 0 });
    await limpiar();
  });

  it('concurrencia: dos confirmaciones de la misma oferta a la vez, una sola gana', async () => {
    const reserva = await reservaCadena(cliente);
    const oferta = (
      await buscarCambio(c.app, cliente, reserva.id, [
        { itineraryId: reserva.itinerario, newDepartureDate: nueva.fecha },
      ]).expect(200)
    ).body[0].changeOfferId;
    const antes = (await cupoDe(c.prisma, nueva.salida)).disponibles;
    const respuestas = await Promise.all(
      [1, 2, 3].map(() =>
        confirmarCambio(c.app, cliente, reserva.id, {
          changeOfferId: oferta,
          payment: { paymentReference: referenciaPago() },
        }),
      ),
    );
    expect(respuestas.filter((r) => r.status === 200)).toHaveLength(1);
    expect(respuestas.filter((r) => r.status === 409)).toHaveLength(2);
    expect((await cupoDe(c.prisma, nueva.salida)).disponibles).toBe(antes - 1);
    expect(await estadoEnBase(c.prisma, reserva.id)).toMatchObject({ lineas: 1, asientos: 1 });
    await limpiar();
  });

  it('cancelar una reserva cambiada no devuelve los cargos de cambio (BUSCA retiene 50 %)', async () => {
    const reserva = await reservaCadena(cliente);
    const oferta = (
      await buscarCambio(c.app, cliente, reserva.id, [
        { itineraryId: reserva.itinerario, newDepartureDate: nueva.fecha },
      ]).expect(200)
    ).body[0].changeOfferId;
    await confirmarCambio(c.app, cliente, reserva.id, {
      changeOfferId: oferta,
      payment: { paymentReference: referenciaPago() },
    }).expect(200);
    const cotizacion = await cotizar(c.app, cliente, reserva.id).expect(200);
    // Pagado: 60.30 + 23.70 de diferencia + 5.00 de cargo = 89.00; vuelve el 50 % de 84.00
    expect(cotizacion.body).toMatchObject({ refundAmount: '42.00', penaltyAmount: '47.00' });
    // Se reembolsa el boleto vigente; el canjeado por el cambio sigue VOIDED
    const cancelada = await cancelar(c.app, cliente, reserva.id, {
      quoteId: cotizacion.body.quoteId,
    }).expect(200);
    expect(cancelada.body.tickets.map((t: { status: string }) => t.status).sort()).toEqual([
      'REFUNDED',
      'VOIDED',
    ]);
    await limpiar();
  });
});

describe('Postventa con una Payment API que rechaza lo pendiente', () => {
  const pagos: ServicioPagos = {
    // Aprueba lo que empieza con PAY-OK (la reserva) y deja pendiente lo demás
    autorizar: ({ referencia }) =>
      Promise.resolve(referencia.startsWith('PAY-OK') ? 'APROBADO' : 'PENDIENTE'),
    consultar: () => Promise.resolve('RECHAZADO'),
    reembolsar: () => Promise.resolve('PENDIENTE'),
    consultarReembolso: () => Promise.resolve('RECHAZADO'),
  };
  let app: INestApplication;
  let prisma: PrismaService;
  let cliente: Cliente;
  const limites = new LimitesReiniciables();

  beforeAll(async () => {
    app = await crearApp([], {
      limites,
      reemplazos: [{ proveedor: SERVICIO_PAGOS, valor: pagos }],
    });
    prisma = app.get(PrismaService);
    cliente = await nuevoCliente(app);
  });
  afterAll(async () => {
    await desactivarUsuariosDePrueba(app);
    await app.close();
  });

  it('una maleta pendiente que se rechaza deja de contar', async () => {
    const reserva = await reservaSemilla(app, cliente, 70, { fareBrand: 'CLASSIC' });
    await comprar(app, cliente, reserva.id, {
      passengerId: 'ADU1',
      itineraryId: reserva.itinerario,
      quantity: 2,
      payment: { paymentReference: referenciaPago('PEND') },
    }).expect(202);
    expect((await estadoEnBase(prisma, reserva.id)).maletas).toBe(2);
    await app.get(PendientesPostventa).ejecutar();
    expect((await estadoEnBase(prisma, reserva.id)).maletas).toBe(0);
    const detalle = await con(app, cliente.token)('get', `${RESERVAS}/${reserva.id}`).expect(200);
    expect(detalle.body.changes.at(-1).description).toMatch(/not added: payment not authorized/);
  });

  it('un cambio pendiente que se rechaza se deshace: cupo y asientos de los vuelos nuevos vuelven', async () => {
    const reserva = await reservaSemilla(app, cliente, 71, { fareBrand: 'CLASSIC' });
    const [opcion] = (
      await buscarCambio(app, cliente, reserva.id, [
        { itineraryId: reserva.itinerario, newDepartureDate: fechaEn(73) },
      ]).expect(200)
    ).body;
    const salidaNueva = opcion.segments[0].segmentId;
    const antes = await cupoDe(prisma, salidaNueva);
    await confirmarCambio(app, cliente, reserva.id, {
      changeOfferId: opcion.changeOfferId,
      payment: { paymentReference: referenciaPago('PEND') },
    }).expect(202);
    expect((await cupoDe(prisma, salidaNueva)).disponibles).toBe(antes.disponibles - 1);
    await app.get(PendientesPostventa).ejecutar();
    expect((await cupoDe(prisma, salidaNueva)).disponibles).toBe(antes.disponibles);
    const detalle = await con(app, cliente.token)('get', `${RESERVAS}/${reserva.id}`).expect(200);
    expect(detalle.body.status).toBe('CONFIRMED');
    expect(detalle.body.itineraries[0].segments[0].segmentId).toBe(reserva.salida);
    expect(detalle.body.changes.at(-1).description).toMatch(/not applied/);
    expect(
      await prisma.db.cambio_cabecera.findUniqueOrThrow({ where: { id: opcion.changeOfferId } }),
    ).toMatchObject({ estado: 'FALLIDO' });
    expect(await estadoEnBase(prisma, reserva.id)).toMatchObject({ lineas: 1, asientos: 1 });
  });
});

describe('Seguridad y límites de la postventa', () => {
  let app: INestApplication;
  let cliente: Cliente;
  const limites = new LimitesReiniciables();
  const id = randomUUID();
  const rutas: Array<['get' | 'post', string, string]> = [
    ['get', `${RESERVAS}/${id}/baggage-options`, 'flights:read'],
    ['post', `${RESERVAS}/${id}/baggage`, 'flights:book'],
    ['post', `${RESERVAS}/${id}/date-change/search`, 'flights:read'],
    ['post', `${RESERVAS}/${id}/date-change`, 'flights:book'],
    ['get', `${RESERVAS}/${id}/cancellation-quote`, 'flights:read'],
    ['post', `${RESERVAS}/${id}/cancel`, 'flights:cancel'],
  ];

  beforeAll(async () => {
    app = await crearApp([], { limites });
    cliente = await nuevoCliente(app);
  });
  beforeEach(() => limites.reiniciar());
  afterAll(async () => {
    await desactivarUsuariosDePrueba(app);
    await app.close();
  });

  it('sin token: 401 en las seis operaciones; sin el scope: 403 diciendo cuál falta', async () => {
    for (const [metodo, ruta, scope] of rutas) {
      const sinToken = await con(app)(metodo, ruta).set('Idempotency-Key', randomUUID()).send({});
      expect(sinToken.status).toBe(401);
      esperarProblemDetails(sinToken);
      const otroScope = scope === 'flights:read' ? 'flights:book' : 'flights:read';
      const token = firmarToken(app, { scope: otroScope }, { subject: cliente.id, expiresIn: 60 });
      const sinScope = await con(app, token)(metodo, ruta)
        .set('Idempotency-Key', randomUUID())
        .send({});
      expect(sinScope.status).toBe(403);
      expect(sinScope.body.detail).toContain(scope);
    }
  });

  it.each([
    ['baggage', 10],
    ['date-change/search', 20],
    ['date-change', 10],
    ['cancel', 10],
  ])('POST .../%s: %i por minuto e IP, después 429 con Retry-After', async (ruta, limite) => {
    const reserva = randomUUID();
    const pedir = () =>
      con(app, cliente.token)('post', `${RESERVAS}/${reserva}/${ruta}`)
        .set('Idempotency-Key', randomUUID())
        .send({});
    for (let i = 0; i < limite; i++) expect((await pedir()).status).toBe(400);
    const excedida = await pedir();
    expect(excedida.status).toBe(429);
    expect(excedida.body.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(Number(excedida.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });
});
