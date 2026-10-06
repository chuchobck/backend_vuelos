import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { GeneradorCodigos } from '../src/modules/vuelos/compartido/generador-codigos';
import {
  SERVICIO_PAGOS,
  ServicioPagos,
} from '../src/modules/vuelos/compartido/pagos/servicio-pagos';
import { EmisionPendiente } from '../src/modules/vuelos/operaciones/reserva/emision-pendiente';
import { PrismaService } from '../src/prisma/prisma.service';
import { desactivarUsuariosDePrueba, firmarToken } from './utils/auth';
import { CadenaBusqueda, crearCadena, darDeBajaCadena, fechaEn } from './utils/busqueda';
import { ADMIN, AppCatalogo, codigos, crearAppCatalogo } from './utils/catalogo';
import { erroresContraContrato } from './utils/contrato';
import { crearApp } from './utils/crear-app';
import { LimitesReiniciables } from './utils/limites';
import { esperarProblemDetails } from './utils/problem-details';
import { RelojDePrueba } from './utils/reloj';
import {
  asientosOcupados,
  buscarYRetener,
  con,
  cuerpoReserva,
  cupoDe,
  HOLD,
  nuevoCliente,
  pasajero,
  asientosLibres,
  referenciaPago,
  reservar,
  RESERVAS,
  Retenido,
} from './utils/reserva';

type Cliente = { id: string; token: string };

const REGEX_BOLETO = /^[0-9]{13}$/;
const REGEX_PNR = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

function esperarContrato(esquema: string, cuerpo: unknown): void {
  expect(erroresContraContrato(esquema, cuerpo)).toEqual([]);
}

/** UIO-GYE directo, solo ida, para `pasajeros`, en una fecha propia de la prueba. */
const soloIda = (
  app: INestApplication,
  cliente: Cliente,
  dias: number,
  pasajeros: { adults?: number; children?: number; infants?: number } = { adults: 1 },
) =>
  buscarYRetener(app, cliente.token, [['UIO', 'GYE', fechaEn(dias)]], pasajeros, { directa: true });

async function estadoHold(prisma: PrismaService, holdId: string): Promise<string> {
  return (await prisma.db.retencion_cabecera.findUniqueOrThrow({ where: { id: holdId } })).estado;
}

async function reservasDelHold(prisma: PrismaService, holdId: string): Promise<number> {
  return prisma.db.reserva_cabecera.count({ where: { retencion_id: holdId } });
}

describe('POST /bookings sobre la semilla', () => {
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

  describe('reserva con pago aprobado', () => {
    let retenido: Retenido;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- el cuerpo se valida contra el contrato
    let reserva: Record<string, any>;
    let referencia: string;

    beforeAll(async () => {
      reloj.alPresente();
      retenido = await soloIda(app, cliente, 31);
      referencia = referenciaPago();
      const respuesta = await reservar(
        app,
        cliente.token,
        cuerpoReserva(retenido.holdId, [pasajero('ADULT', 1)], referencia),
      ).expect(201);
      reserva = respuesta.body;
    });

    it('201 que cumple BookingDetail: CONFIRMED, el precio del hold y un boleto emitido', () => {
      esperarContrato('BookingDetail', reserva);
      expect(reserva).toMatchObject({ status: 'CONFIRMED', grandTotal: retenido.precio });
      expect(reserva.pnr).toMatch(REGEX_PNR);
      expect(reserva.tickets).toHaveLength(1);
      const [boleto] = reserva.tickets;
      esperarContrato('Ticket', boleto);
      expect(boleto).toMatchObject({ status: 'ISSUED', passengerId: 'ADU1', failureReason: null });
      // Prefijo de la aerolínea de la semilla (AV 134, LA 045) y 10 dígitos
      expect(boleto.eTicketNumber).toMatch(REGEX_BOLETO);
      expect(['134', '045']).toContain(boleto.eTicketNumber.slice(0, 3));
      expect(boleto.segments).toEqual([
        {
          segmentId: retenido.oferta.itineraries[0].segments[0].segmentId,
          status: 'ISSUED',
          couponNumber: '1',
        },
      ]);
      expect(reserva.changes.map((c: { description: string }) => c.description)).toEqual([
        'Booking created from hold',
        'Payment approved; issuing tickets',
        '1 ticket(s) issued',
        'Booking confirmed',
      ]);
    });

    it('el hold queda CONSUMIDA y el cupo no cambia (ya lo había tomado el hold)', async () => {
      expect(await estadoHold(prisma, retenido.holdId)).toBe('CONSUMIDA');
      const salida = retenido.oferta.itineraries[0].segments[0].segmentId;
      const cupo = await cupoDe(prisma, salida);
      expect(cupo.disponibles + cupo.tomados).toBe(cupo.totales);
    });

    it('guarda el pago (solo la referencia), el historial y la auditoría con el dueño', async () => {
      const pago = await prisma.db.reserva_detalle_pago.findFirstOrThrow({
        where: { reserva_id: reserva.bookingId },
      });
      expect(pago).toMatchObject({ referencia_pago: referencia, concepto: 'EMISION' });
      const auditoria = await prisma.db.auditoria.findMany({
        where: { nombre_tabla: 'reserva_cabecera', id_registro: reserva.bookingId },
        orderBy: { id: 'asc' },
      });
      expect(auditoria.length).toBeGreaterThanOrEqual(1);
      expect(auditoria.every((a) => a.id_usuario === cliente.id)).toBe(true);
    });

    it('no devuelve ids internos ni datos del dueño', () => {
      const texto = JSON.stringify(reserva);
      expect(texto).not.toContain(cliente.id);
      expect(texto).not.toMatch(/"(id|reserva_id|pasajero_id|retencion_id)"/);
    });

    it('GET /bookings/{id} devuelve la misma reserva y cumple BookingDetail', async () => {
      const detalle = await con(app, cliente.token)(
        'get',
        `${RESERVAS}/${reserva.bookingId}`,
      ).expect(200);
      esperarContrato('BookingDetail', detalle.body);
      expect(detalle.body).toEqual(reserva);
    });

    it('GET de los tickets: TicketListResponse y Ticket del contrato', async () => {
      const lista = await con(app, cliente.token)(
        'get',
        `${RESERVAS}/${reserva.bookingId}/tickets`,
      ).expect(200);
      esperarContrato('TicketListResponse', lista.body);
      expect(lista.body).toEqual({ bookingId: reserva.bookingId, tickets: reserva.tickets });
      const uno = await con(app, cliente.token)(
        'get',
        `${RESERVAS}/${reserva.bookingId}/tickets/${reserva.tickets[0].ticketId}`,
      ).expect(200);
      esperarContrato('Ticket', uno.body);
      expect(uno.body).toEqual(reserva.tickets[0]);
    });

    it('la reserva de otro usuario no existe para él: 404 en el detalle y en los tickets', async () => {
      for (const ruta of [
        `${RESERVAS}/${reserva.bookingId}`,
        `${RESERVAS}/${reserva.bookingId}/tickets`,
        `${RESERVAS}/${reserva.bookingId}/tickets/${reserva.tickets[0].ticketId}`,
      ]) {
        const respuesta = await con(app, otro.token)('get', ruta);
        expect(respuesta.status).toBe(404);
        esperarProblemDetails(respuesta);
      }
      const inexistente = await con(app, cliente.token)('get', `${RESERVAS}/${randomUUID()}`);
      expect(inexistente.status).toBe(404);
      const ticketAjeno = await con(app, cliente.token)(
        'get',
        `${RESERVAS}/${reserva.bookingId}/tickets/no-es-un-ticket`,
      );
      expect(ticketAjeno.status).toBe(404);
    });

    it('la misma referencia de pago en otra reserva: 409 PAYMENT_REFERENCE_INVALID', async () => {
      const nuevo = await soloIda(app, cliente, 32);
      const respuesta = await reservar(
        app,
        cliente.token,
        cuerpoReserva(nuevo.holdId, [pasajero('ADULT', 1)], referencia),
      );
      expect(respuesta.status).toBe(409);
      esperarProblemDetails(respuesta);
      expect(respuesta.body.code).toBe('PAYMENT_REFERENCE_INVALID');
      expect(await estadoHold(prisma, nuevo.holdId)).toBe('RETENIDA');
    });
  });

  it('ida y vuelta con adulto, niño e infante: asientos para los que ocupan asiento, boleto para todos', async () => {
    const pasajeros = { adults: 1, children: 1, infants: 1 };
    const retenido = await buscarYRetener(
      app,
      cliente.token,
      [
        ['UIO', 'GYE', fechaEn(33)],
        ['GYE', 'UIO', fechaEn(36)],
      ],
      pasajeros,
    );
    const adulto = pasajero('ADULT', 1);
    const cuerpo = cuerpoReserva(retenido.holdId, [
      adulto,
      pasajero('CHILD', 2),
      pasajero('INFANT', 3, { associatedAdultId: adulto.passengerId }),
    ]);
    const respuesta = await reservar(app, cliente.token, cuerpo).expect(201);
    esperarContrato('BookingDetail', respuesta.body);
    expect(respuesta.body.grandTotal).toEqual(retenido.precio);
    const segmentos = retenido.oferta.itineraries.flatMap((it) =>
      it.segments.map((s) => s.segmentId),
    );

    const porId = Object.fromEntries(
      respuesta.body.passengers.map((p: { passengerId: string }) => [p.passengerId, p]),
    );
    for (const id of ['ADU1', 'CHI2']) {
      expect(porId[id].assignedSeats.map((a: { segmentId: string }) => a.segmentId).sort()).toEqual(
        [...segmentos].sort(),
      );
    }
    expect(porId.INF3).toMatchObject({ associatedAdultId: 'ADU1', assignedSeats: [] });

    expect(respuesta.body.tickets).toHaveLength(3);
    for (const boleto of respuesta.body.tickets) {
      expect(boleto.status).toBe('ISSUED');
      expect(boleto.segments.map((s: { couponNumber: string }) => s.couponNumber)).toEqual(
        segmentos.map((_, i) => String(i + 1)),
      );
    }
  });

  it('asiento elegido: lo respeta; sin elegir, el primero libre de la cabina por fila y letra', async () => {
    const retenido = await soloIda(app, cliente, 37, { adults: 2 });
    const salida = retenido.oferta.itineraries[0].segments[0].segmentId;
    const libres = await asientosLibres(prisma, salida);
    // Elige el último libre; el otro pasajero recibe el primero
    const [esperado, elegidoNumero] = [libres[0], libres[libres.length - 1]];
    const respuesta = await reservar(
      app,
      cliente.token,
      cuerpoReserva(retenido.holdId, [
        pasajero('ADULT', 1, { assignedSeats: [{ segmentId: salida, seatNumber: elegidoNumero }] }),
        pasajero('ADULT', 2),
      ]),
    ).expect(201);
    const [elegido, automatico] = respuesta.body.passengers;
    expect(elegido.assignedSeats).toEqual([{ segmentId: salida, seatNumber: elegidoNumero }]);
    expect(automatico.assignedSeats).toEqual([{ segmentId: salida, seatNumber: esperado }]);
    expect(await asientosOcupados(prisma, salida)).toEqual(
      expect.arrayContaining([elegidoNumero, esperado]),
    );
  });

  describe('asientos que no se pueden asignar', () => {
    let retenido: Retenido;
    let salida: string;
    beforeAll(async () => {
      reloj.alPresente();
      retenido = await soloIda(app, cliente, 38);
      salida = retenido.oferta.itineraries[0].segments[0].segmentId;
    });

    it.each([
      ['un asiento que no existe en la aeronave', '99A', 422, 'VALIDATION_FAILED'],
      ['un asiento de ejecutiva en un hold de económica', '1A', 422, 'SEAT_CABIN_MISMATCH'],
    ])('%s: %s y el hold sigue RETENIDA', async (_caso, asiento, status, code) => {
      const respuesta = await reservar(
        app,
        cliente.token,
        cuerpoReserva(retenido.holdId, [
          pasajero('ADULT', 1, { assignedSeats: [{ segmentId: salida, seatNumber: asiento }] }),
        ]),
      );
      expect(respuesta.status).toBe(status);
      esperarProblemDetails(respuesta);
      expect(respuesta.body.code).toBe(code);
      expect(await estadoHold(prisma, retenido.holdId)).toBe('RETENIDA');
      expect(await reservasDelHold(prisma, retenido.holdId)).toBe(0);
    });

    it('un asiento ocupado por otra reserva: 409 SEAT_TAKEN', async () => {
      const libres = await asientosLibres(prisma, salida);
      const tomado = libres[libres.length - 1];
      const primero = await soloIda(app, otro, 38);
      await reservar(
        app,
        otro.token,
        cuerpoReserva(primero.holdId, [
          pasajero('ADULT', 1, { assignedSeats: [{ segmentId: salida, seatNumber: tomado }] }),
        ]),
      ).expect(201);
      const respuesta = await reservar(
        app,
        cliente.token,
        cuerpoReserva(retenido.holdId, [
          pasajero('ADULT', 1, { assignedSeats: [{ segmentId: salida, seatNumber: tomado }] }),
        ]),
      );
      expect(respuesta.status).toBe(409);
      esperarProblemDetails(respuesta);
      expect(respuesta.body.code).toBe('SEAT_TAKEN');
      expect(await estadoHold(prisma, retenido.holdId)).toBe('RETENIDA');
    });

    it('un segmento que no es del hold: 422', async () => {
      const respuesta = await reservar(
        app,
        cliente.token,
        cuerpoReserva(retenido.holdId, [
          pasajero('ADULT', 1, { assignedSeats: [{ segmentId: randomUUID(), seatNumber: '12A' }] }),
        ]),
      );
      expect(respuesta.status).toBe(422);
      expect(respuesta.body.invalidParams[0].name).toBe('passengers[0].assignedSeats[0].segmentId');
    });
  });

  describe('el hold', () => {
    it('vencido: 410', async () => {
      const retenido = await soloIda(app, cliente, 39);
      reloj.adelantar(16);
      const respuesta = await reservar(
        app,
        cliente.token,
        cuerpoReserva(retenido.holdId, [pasajero('ADULT', 1)]),
      );
      expect(respuesta.status).toBe(410);
      esperarProblemDetails(respuesta);
      expect(respuesta.body.code).toBe('OFFER_NO_LONGER_AVAILABLE');
      expect(await reservasDelHold(prisma, retenido.holdId)).toBe(0);
    });

    it('liberado por su dueño: 410', async () => {
      const retenido = await soloIda(app, cliente, 39);
      await con(app, cliente.token)('delete', `${HOLD}/${retenido.holdId}`).expect(204);
      const respuesta = await reservar(
        app,
        cliente.token,
        cuerpoReserva(retenido.holdId, [pasajero('ADULT', 1)]),
      );
      expect(respuesta.status).toBe(410);
    });

    it('de otro usuario o inexistente: 422 con el mismo mensaje (no revela que existe)', async () => {
      const ajeno = await soloIda(app, otro, 40);
      const respuestas = [
        await reservar(app, cliente.token, cuerpoReserva(ajeno.holdId, [pasajero('ADULT', 1)])),
        await reservar(app, cliente.token, cuerpoReserva(randomUUID(), [pasajero('ADULT', 1)])),
      ];
      for (const respuesta of respuestas) {
        expect(respuesta.status).toBe(422);
        esperarProblemDetails(respuesta);
        expect(respuesta.body.detail).toBe('holdId: the hold was not found');
      }
      expect(await estadoHold(prisma, ajeno.holdId)).toBe('RETENIDA');
    });

    it('ya consumido por otra reserva (otra clave): 409', async () => {
      const retenido = await soloIda(app, cliente, 40);
      const cuerpo = cuerpoReserva(retenido.holdId, [pasajero('ADULT', 1)]);
      await reservar(app, cliente.token, cuerpo).expect(201);
      const respuesta = await reservar(app, cliente.token, {
        ...cuerpo,
        payment: { paymentReference: referenciaPago() },
      });
      expect(respuesta.status).toBe(409);
      esperarProblemDetails(respuesta);
      expect(respuesta.body.detail).toMatch(/already used for a booking/);
      expect(await reservasDelHold(prisma, retenido.holdId)).toBe(1);
    });
  });

  describe('pago', () => {
    it('rechazado: 422 PAYMENT_NOT_AUTHORIZED, sin reserva, el hold intacto y la clave libre', async () => {
      const retenido = await soloIda(app, cliente, 41);
      const clave = randomUUID();
      const respuesta = await reservar(
        app,
        cliente.token,
        cuerpoReserva(retenido.holdId, [pasajero('ADULT', 1)], referenciaPago('REJ')),
        clave,
      );
      expect(respuesta.status).toBe(422);
      esperarProblemDetails(respuesta);
      expect(respuesta.body.code).toBe('PAYMENT_NOT_AUTHORIZED');
      expect(await estadoHold(prisma, retenido.holdId)).toBe('RETENIDA');
      expect(await reservasDelHold(prisma, retenido.holdId)).toBe(0);
      expect(await prisma.db.clave_idempotencia.count({ where: { clave } })).toBe(0);
    });

    it('una referencia que no es de la Payment API: 422 PAYMENT_REFERENCE_INVALID', async () => {
      const retenido = await soloIda(app, cliente, 41);
      const respuesta = await reservar(
        app,
        cliente.token,
        cuerpoReserva(retenido.holdId, [pasajero('ADULT', 1)], 'TRANSFER-12345678'),
      );
      expect(respuesta.status).toBe(422);
      expect(respuesta.body.code).toBe('PAYMENT_REFERENCE_INVALID');
    });

    it('pendiente: 202 en PENDING_PAYMENT con boletos PENDING; el proceso los emite después', async () => {
      const retenido = await soloIda(app, cliente, 42);
      const respuesta = await reservar(
        app,
        cliente.token,
        cuerpoReserva(retenido.holdId, [pasajero('ADULT', 1)], referenciaPago('PEND')),
      );
      expect(respuesta.status).toBe(202);
      esperarContrato('BookingDetail', respuesta.body);
      expect(respuesta.body.status).toBe('PENDING_PAYMENT');
      expect(respuesta.body.tickets).toEqual([
        expect.objectContaining({ status: 'PENDING', eTicketNumber: null, issuedAt: null }),
      ]);
      expect(respuesta.body.tickets[0].segments[0]).toMatchObject({
        status: 'PENDING',
        couponNumber: null,
      });

      const resultado = await app.get(EmisionPendiente).ejecutar();
      expect(resultado.confirmadas).toBeGreaterThanOrEqual(1);
      const detalle = await con(app, cliente.token)(
        'get',
        `${RESERVAS}/${respuesta.body.bookingId}`,
      ).expect(200);
      esperarContrato('BookingDetail', detalle.body);
      expect(detalle.body.status).toBe('CONFIRMED');
      expect(detalle.body.tickets[0]).toMatchObject({ status: 'ISSUED' });
      expect(detalle.body.tickets[0].eTicketNumber).toMatch(REGEX_BOLETO);
      expect(detalle.body.changes.map((c: { description: string }) => c.description)).toEqual([
        'Booking created from hold',
        'Payment pending confirmation; tickets will be issued once it is approved',
        'Payment approved; issuing tickets',
        '1 ticket(s) issued',
        'Booking confirmed',
      ]);
      // Una segunda corrida no la vuelve a emitir
      await app.get(EmisionPendiente).ejecutar();
      const boletos = await prisma.db.boleto_cabecera.count({
        where: { reserva_detalle_pasajero: { reserva_id: respuesta.body.bookingId } },
      });
      expect(boletos).toBe(1);
    });
  });

  describe('idempotencia', () => {
    it('la misma clave con el mismo cuerpo devuelve la misma reserva sin consumir dos veces', async () => {
      const retenido = await soloIda(app, cliente, 43);
      const clave = randomUUID();
      const cuerpo = cuerpoReserva(retenido.holdId, [pasajero('ADULT', 1)]);
      const primera = await reservar(app, cliente.token, cuerpo, clave).expect(201);
      const segunda = await reservar(app, cliente.token, cuerpo, clave).expect(201);
      expect(segunda.headers['idempotent-replayed']).toBe('true');
      expect(segunda.body).toEqual(primera.body);
      expect(await reservasDelHold(prisma, retenido.holdId)).toBe(1);
    });

    it('la misma clave con otro cuerpo: 422', async () => {
      const retenido = await soloIda(app, cliente, 43);
      const clave = randomUUID();
      const cuerpo = cuerpoReserva(retenido.holdId, [pasajero('ADULT', 1)]);
      await reservar(app, cliente.token, cuerpo, clave).expect(201);
      const otraCosa = await reservar(
        app,
        cliente.token,
        { ...cuerpo, passengers: [pasajero('ADULT', 1, { firstName: 'Otra' })] },
        clave,
      );
      expect(otraCosa.status).toBe(422);
      esperarProblemDetails(otraCosa);
      expect(otraCosa.body.invalidParams).toEqual([
        { name: 'Idempotency-Key', reason: expect.any(String) },
      ]);
    });

    it('el mismo cuerpo con otra clave: 409 (el hold ya se consumió)', async () => {
      const retenido = await soloIda(app, cliente, 44);
      const cuerpo = cuerpoReserva(retenido.holdId, [pasajero('ADULT', 1)]);
      await reservar(app, cliente.token, cuerpo).expect(201);
      const otraClave = await reservar(app, cliente.token, cuerpo);
      expect(otraClave.status).toBe(409);
    });

    it('sin Idempotency-Key o con una que no es uuid: 400', async () => {
      const cuerpo = cuerpoReserva(randomUUID(), [pasajero('ADULT', 1)]);
      for (const clave of [null, 'no-es-uuid']) {
        const respuesta = await reservar(app, cliente.token, cuerpo, clave);
        expect(respuesta.status).toBe(400);
        expect(respuesta.body.invalidParams[0].name).toBe('Idempotency-Key');
      }
    });
  });

  describe('pasajeros', () => {
    let retenido: Retenido;
    const adulto = pasajero('ADULT', 1);
    beforeAll(async () => {
      reloj.alPresente();
      retenido = await soloIda(app, cliente, 45, { adults: 1, infants: 1 });
    });
    const infante = (cambios: object = {}) =>
      pasajero('INFANT', 2, { associatedAdultId: adulto.passengerId, ...cambios });

    it.each<[string, () => object[], number, string]>([
      ['menos pasajeros que el hold', () => [adulto], 422, 'passengers'],
      ['un tipo que no es el del hold', () => [adulto, pasajero('CHILD', 2)], 422, 'passengers'],
      [
        'un infante sin adulto',
        () => [adulto, infante({ associatedAdultId: undefined })],
        400,
        'passengers[1].associatedAdultId',
      ],
      [
        'un infante con un adulto que no está',
        () => [adulto, infante({ associatedAdultId: 'NADIE' })],
        400,
        'passengers[1].associatedAdultId',
      ],
      [
        'un adulto con associatedAdultId',
        () => [{ ...adulto, associatedAdultId: 'INF2' }, infante()],
        400,
        'passengers[0].associatedAdultId',
      ],
      [
        'passengerId repetido',
        () => [adulto, infante({ passengerId: adulto.passengerId })],
        400,
        'passengers[1].passengerId',
      ],
      [
        'documento repetido',
        () => [adulto, infante({ documentNumber: adulto.documentNumber })],
        400,
        'passengers[1].documentNumber',
      ],
      [
        'un adulto con la edad de un niño',
        () => [{ ...adulto, birthDate: fechaEn(-365 * 8) }, infante()],
        422,
        'passengers[0].birthDate',
      ],
      [
        'un infante de 3 años',
        () => [adulto, infante({ birthDate: fechaEn(-365 * 3) })],
        422,
        'passengers[1].birthDate',
      ],
      [
        'nacido después del vuelo',
        () => [adulto, infante({ birthDate: fechaEn(60) })],
        422,
        'passengers[1].birthDate',
      ],
      [
        'una cédula con el dígito verificador mal',
        () => [{ ...adulto, documentNumber: '1710034066' }, infante()],
        400,
        'passengers[0].documentNumber',
      ],
      [
        'un pasaporte sin vencimiento',
        () => [{ ...adulto, documentType: 'PASSPORT', documentNumber: 'AB123456' }, infante()],
        400,
        'passengers[0].documentExpiryDate',
      ],
      [
        'un pasaporte que vence antes del viaje',
        () => [
          {
            ...adulto,
            documentType: 'PASSPORT',
            documentNumber: 'AB123456',
            documentExpiryDate: fechaEn(10),
          },
          infante(),
        ],
        422,
        'passengers[0].documentExpiryDate',
      ],
      [
        'una nacionalidad que la API no conoce',
        () => [
          {
            ...adulto,
            documentType: 'PASSPORT',
            documentNumber: 'AB123456',
            documentExpiryDate: fechaEn(800),
            nationality: 'PE',
          },
          infante(),
        ],
        422,
        'passengers[0].nationality',
      ],
      [
        'un nombre con dígitos',
        () => [{ ...adulto, firstName: 'Ana2' }, infante()],
        400,
        'passengers[0].firstName',
      ],
      [
        'un nombre con HTML',
        () => [{ ...adulto, lastName: '<b>Pérez</b>' }, infante()],
        400,
        'passengers[0].lastName',
      ],
      [
        'un teléfono sin dígitos suficientes',
        () => [{ ...adulto, contact: { email: 'a@e2e.quinde.example', phone: '12' } }, infante()],
        400,
        'passengers[0].contact.phone',
      ],
      [
        'un correo inválido',
        () => [
          { ...adulto, contact: { email: 'no-es-correo', phone: '+593991234567' } },
          infante(),
        ],
        400,
        'passengers[0].contact.email',
      ],
      [
        'un infante con asiento',
        () => [
          adulto,
          infante({ assignedSeats: [{ segmentId: randomUUID(), seatNumber: '12A' }] }),
        ],
        422,
        'passengers[1].assignedSeats',
      ],
      [
        'equipaje adicional al reservar',
        () => [
          { ...adulto, extraBaggage: [{ itineraryId: randomUUID(), quantity: 1 }] },
          infante(),
        ],
        422,
        'passengers[0].extraBaggage',
      ],
      [
        'un campo de más',
        () => [{ ...adulto, ownerId: 'x' }, infante()],
        400,
        'passengers[0].ownerId',
      ],
    ])('%s', async (_caso, pasajeros, status, campo) => {
      const lista = pasajeros();
      const respuesta = await reservar(app, cliente.token, cuerpoReserva(retenido.holdId, lista));
      expect(respuesta.status).toBe(status);
      esperarProblemDetails(respuesta);
      expect(respuesta.body.invalidParams.map((p: { name: string }) => p.name)).toContain(campo);
      // Ni el nombre ni el documento aparecen en el error
      const texto = JSON.stringify(respuesta.body);
      expect(texto).not.toContain(adulto.documentNumber);
      expect(texto).not.toContain(adulto.lastName);
      expect(await estadoHold(prisma, retenido.holdId)).toBe('RETENIDA');
    });

    it('con los mismos datos válidos, la reserva sale (el documento se normaliza)', async () => {
      const respuesta = await reservar(
        app,
        cliente.token,
        cuerpoReserva(retenido.holdId, [
          {
            ...adulto,
            documentNumber: `${adulto.documentNumber.slice(0, 5)}-${adulto.documentNumber.slice(5)}`,
          },
          infante(),
        ]),
      ).expect(201);
      expect(respuesta.body.passengers[0].documentNumber).toBe(adulto.documentNumber);
    });
  });

  describe('listado', () => {
    let listador: Cliente;
    const pnrs: string[] = [];
    const creadas: string[] = [];
    beforeAll(async () => {
      reloj.alPresente();
      limites.reiniciar();
      listador = await nuevoCliente(app);
      for (const dias of [46, 47, 48]) {
        // Un minuto entre una y otra: el orden es por creación (y el id solo desempata)
        reloj.adelantar(1);
        const retenido = await soloIda(app, listador, dias);
        const r = await reservar(
          app,
          listador.token,
          cuerpoReserva(retenido.holdId, [pasajero('ADULT', 1)]),
        ).expect(201);
        pnrs.unshift(r.body.pnr);
        creadas.push(r.body.createdAt);
      }
    });
    const listar = (query: string, token = listador.token) =>
      con(app, token)('get', `${RESERVAS}${query}`);

    it('solo las del usuario, de la más reciente a la más vieja, y cumple BookingListResponse', async () => {
      const respuesta = await listar('').expect(200);
      esperarContrato('BookingListResponse', respuesta.body);
      expect(respuesta.body.items.map((i: { pnr: string }) => i.pnr)).toEqual(pnrs);
      expect(respuesta.body.nextCursor).toBeUndefined();
      expect(respuesta.body.items[0]).toMatchObject({
        status: 'CONFIRMED',
        origin: 'UIO',
        destination: 'GYE',
        departureDate: fechaEn(48),
      });
      expect(
        (await listar('', otro.token).expect(200)).body.items.map((i: { pnr: string }) => i.pnr),
      ).not.toEqual(expect.arrayContaining(pnrs));
    });

    it('pagina por cursor sin repetir ni saltar', async () => {
      const primera = await listar('?limit=2').expect(200);
      expect(primera.body.items).toHaveLength(2);
      expect(primera.body.nextCursor).toEqual(expect.any(String));
      const segunda = await listar(`?limit=2&cursor=${primera.body.nextCursor}`).expect(200);
      expect(
        [...primera.body.items, ...segunda.body.items].map((i: { pnr: string }) => i.pnr),
      ).toEqual(pnrs);
      expect(segunda.body.nextCursor).toBeUndefined();
    });

    it('filtra por pnr (sin importar mayúsculas), estado y fecha de creación', async () => {
      expect(
        (await listar(`?pnr=${pnrs[1].toLowerCase()}`).expect(200)).body.items.map(
          (i: { pnr: string }) => i.pnr,
        ),
      ).toEqual([pnrs[1]]);
      expect((await listar('?status=CONFIRMED').expect(200)).body.items).toHaveLength(3);
      expect((await listar('?status=CANCELLED').expect(200)).body.items).toHaveLength(0);
      const dia = creadas[1].slice(0, 10);
      const delDia = creadas.filter((c) => c.startsWith(dia)).length;
      expect(
        (await listar(`?createdFrom=${dia}&createdTo=${dia}`).expect(200)).body.items,
      ).toHaveLength(delDia);
      expect((await listar('?createdTo=2020-01-01').expect(200)).body.items).toHaveLength(0);
    });

    it.each([
      ['?limit=51', 'limit'],
      ['?limit=0', 'limit'],
      ['?status=ABIERTA', 'status'],
      ['?createdFrom=2026-02-30', 'createdFrom'],
      ['?pnr=ABC', 'pnr'],
      ['?cursor=no-es-un-cursor', 'cursor'],
      ['?createdFrom=2026-10-10&createdTo=2026-10-01', 'createdTo'],
      ['?ownerId=otro', 'ownerId'],
    ])('%s: 400', async (query, campo) => {
      const respuesta = await listar(query);
      expect(respuesta.status).toBe(400);
      esperarProblemDetails(respuesta);
      expect(respuesta.body.invalidParams.map((p: { name: string }) => p.name)).toContain(campo);
    });
  });
});

describe('POST /bookings sobre un catálogo propio', () => {
  const limites = new LimitesReiniciables();
  let c: AppCatalogo;
  let k: CadenaBusqueda;
  let cliente: Cliente;
  const prefijo = { valor: '' };

  const retenerCadena = () =>
    buscarYRetener(c.app, cliente.token, [[k.origen, k.destino, k.fecha]], { adults: 1 });

  beforeAll(async () => {
    c = await crearAppCatalogo({ limites });
    k = await crearCadena(c);
    await c
      .admin('patch', `${ADMIN}/departures/${k.salida}`, {
        cabins: [{ cabinClass: 'ECONOMY', totalSeats: 6 }],
      })
      .expect(200);
    cliente = await nuevoCliente(c.app);
  });
  beforeEach(() => limites.reiniciar());
  afterAll(async () => {
    await c.admin('patch', `${ADMIN}/airlines/${k.aerolinea}`, { ticketPrefix: null }).expect(200);
    await darDeBajaCadena(c, k).catch(() => undefined);
    await desactivarUsuariosDePrueba(c.app);
    await c.cerrar();
  });

  it('una aerolínea sin prefijo de boleto: 422 TICKET_ISSUANCE_FAILED, sin reserva y el hold intacto', async () => {
    const retenido = await retenerCadena();
    const respuesta = await reservar(
      c.app,
      cliente.token,
      cuerpoReserva(retenido.holdId, [pasajero('ADULT', 1)]),
    );
    expect(respuesta.status).toBe(422);
    esperarProblemDetails(respuesta);
    expect(respuesta.body.code).toBe('TICKET_ISSUANCE_FAILED');
    expect(await estadoHold(c.prisma, retenido.holdId)).toBe('RETENIDA');
    await con(c.app, cliente.token)('delete', `${HOLD}/${retenido.holdId}`).expect(204);

    prefijo.valor = await codigos.prefijoBoleto(c.prisma);
    await c
      .admin('patch', `${ADMIN}/airlines/${k.aerolinea}`, { ticketPrefix: prefijo.valor })
      .expect(200);
  });

  it('el precio es el congelado en el hold aunque la tarifa cambie antes de reservar', async () => {
    const retenido = await retenerCadena();
    expect(retenido.precio.total).toBe('60.30');
    await c
      .admin('patch', `${ADMIN}/fares/${k.tarifa}`, {
        prices: [{ passengerType: 'ADULT', baseFare: '90.00', taxes: '18.00' }],
      })
      .expect(200);
    try {
      const respuesta = await reservar(
        c.app,
        cliente.token,
        cuerpoReserva(retenido.holdId, [pasajero('ADULT', 1)]),
      ).expect(201);
      expect(respuesta.body.grandTotal).toEqual({
        currency: 'USD',
        baseFare: '50.10',
        taxes: '10.20',
        total: '60.30',
      });
      expect(respuesta.body.tickets[0].eTicketNumber.slice(0, 3)).toBe(prefijo.valor);
      // Sin asiento elegido: el primero libre de económica (la fila 1 es ejecutiva)
      expect(respuesta.body.passengers[0].assignedSeats).toEqual([
        { segmentId: k.salida, seatNumber: '2A' },
      ]);
    } finally {
      await c
        .admin('patch', `${ADMIN}/fares/${k.tarifa}`, {
          prices: [{ passengerType: 'ADULT', baseFare: '50.10', taxes: '10.20' }],
        })
        .expect(200);
    }
  });

  it('si la aerolínea pierde el prefijo antes de emitir, la reserva FALLA y devuelve asientos y cupo', async () => {
    const retenido = await retenerCadena();
    const antes = await cupoDe(c.prisma, k.salida);
    const respuesta = await reservar(
      c.app,
      cliente.token,
      cuerpoReserva(retenido.holdId, [pasajero('ADULT', 1)], referenciaPago('PEND')),
    ).expect(202);
    const asiento = respuesta.body.passengers[0].assignedSeats[0].seatNumber;
    expect(await asientosOcupados(c.prisma, k.salida)).toContain(asiento);

    await c.admin('patch', `${ADMIN}/airlines/${k.aerolinea}`, { ticketPrefix: null }).expect(200);
    try {
      expect((await c.app.get(EmisionPendiente).ejecutar()).fallidas).toBeGreaterThanOrEqual(1);
    } finally {
      await c
        .admin('patch', `${ADMIN}/airlines/${k.aerolinea}`, { ticketPrefix: prefijo.valor })
        .expect(200);
    }
    const detalle = await con(c.app, cliente.token)(
      'get',
      `${RESERVAS}/${respuesta.body.bookingId}`,
    ).expect(200);
    esperarContrato('BookingDetail', detalle.body);
    expect(detalle.body.status).toBe('FAILED');
    expect(detalle.body.tickets[0]).toMatchObject({ status: 'FAILED', eTicketNumber: null });
    expect(detalle.body.tickets[0].failureReason).toMatch(/no ticket prefix/);
    expect(detalle.body.tickets[0].segments[0].status).toBe('FAILED');
    expect(detalle.body.passengers[0].assignedSeats).toEqual([]);
    expect(await asientosOcupados(c.prisma, k.salida)).not.toContain(asiento);
    const despues = await cupoDe(c.prisma, k.salida);
    expect(despues.disponibles).toBe(antes.disponibles + 1);
    expect(despues.disponibles + despues.tomados).toBe(despues.totales);
  });
});

describe('Concurrencia de POST /bookings', () => {
  const limites = new LimitesReiniciables();
  let c: AppCatalogo;
  let k: CadenaBusqueda;
  let clientes: Cliente[];

  beforeAll(async () => {
    c = await crearAppCatalogo({ limites });
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
    clientes = await Promise.all(Array.from({ length: 4 }, () => nuevoCliente(c.app)));
  });
  beforeEach(() => limites.reiniciar());
  afterAll(async () => {
    await c.admin('patch', `${ADMIN}/airlines/${k.aerolinea}`, { ticketPrefix: null }).expect(200);
    await darDeBajaCadena(c, k).catch(() => undefined);
    await desactivarUsuariosDePrueba(c.app);
    await c.cerrar();
  });

  const retener = (cliente: Cliente) =>
    buscarYRetener(c.app, cliente.token, [[k.origen, k.destino, k.fecha]], { adults: 1 });

  it('8 peticiones simultáneas sobre el mismo hold con claves distintas: exactamente una reserva', async () => {
    const [cliente] = clientes;
    const retenido = await retener(cliente);
    const respuestas = await Promise.all(
      Array.from({ length: 8 }, () =>
        reservar(c.app, cliente.token, cuerpoReserva(retenido.holdId, [pasajero('ADULT', 1)])),
      ),
    );
    expect(respuestas.filter((r) => r.status === 201)).toHaveLength(1);
    expect(respuestas.filter((r) => r.status === 409)).toHaveLength(7);
    expect(await reservasDelHold(c.prisma, retenido.holdId)).toBe(1);
    expect(
      await c.prisma.db.reserva_detalle_pasajero.count({
        where: { reserva_cabecera: { retencion_id: retenido.holdId } },
      }),
    ).toBe(1);
  });

  it('5 peticiones simultáneas con la misma clave: una reserva y la misma respuesta para todas', async () => {
    const [, cliente] = clientes;
    const retenido = await retener(cliente);
    const clave = randomUUID();
    const cuerpo = cuerpoReserva(retenido.holdId, [pasajero('ADULT', 1)]);
    const respuestas = await Promise.all(
      Array.from({ length: 5 }, () => reservar(c.app, cliente.token, cuerpo, clave)),
    );
    expect(respuestas.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(new Set(respuestas.map((r) => r.body.bookingId)).size).toBe(1);
    expect(await reservasDelHold(c.prisma, retenido.holdId)).toBe(1);
  });

  it('4 reservas simultáneas por el mismo asiento: una lo obtiene, las otras 409 SEAT_TAKEN y su hold sigue', async () => {
    const holds = await Promise.all(clientes.map((cliente) => retener(cliente)));
    const respuestas = await Promise.all(
      holds.map((h, i) =>
        reservar(
          c.app,
          clientes[i].token,
          cuerpoReserva(h.holdId, [
            pasajero('ADULT', 1, { assignedSeats: [{ segmentId: k.salida, seatNumber: '3C' }] }),
          ]),
        ),
      ),
    );
    expect(respuestas.filter((r) => r.status === 201)).toHaveLength(1);
    const perdedoras = respuestas.filter((r) => r.status !== 201);
    expect(perdedoras.map((r) => [r.status, r.body.code])).toEqual(
      Array.from({ length: 3 }, () => [409, 'SEAT_TAKEN']),
    );
    expect((await asientosOcupados(c.prisma, k.salida)).filter((a) => a === '3C')).toHaveLength(1);
    for (const [i, r] of respuestas.entries()) {
      expect(await estadoHold(c.prisma, holds[i].holdId)).toBe(
        r.status === 201 ? 'CONSUMIDA' : 'RETENIDA',
      );
      if (r.status !== 201)
        await con(c.app, clientes[i].token)('delete', `${HOLD}/${holds[i].holdId}`).expect(204);
    }
  });

  it('reservas simultáneas sin elegir asiento: cada pasajero recibe uno distinto y todo cuadra', async () => {
    const holds = await Promise.all(clientes.slice(0, 2).map((cliente) => retener(cliente)));
    const respuestas = await Promise.all(
      holds.map((h, i) =>
        reservar(c.app, clientes[i].token, cuerpoReserva(h.holdId, [pasajero('ADULT', 1)])),
      ),
    );
    expect(respuestas.map((r) => r.status)).toEqual([201, 201]);
    const ocupados = await asientosOcupados(c.prisma, k.salida);
    expect(new Set(ocupados).size).toBe(ocupados.length);
    const cupo = await cupoDe(c.prisma, k.salida);
    expect(cupo.disponibles).toBeGreaterThanOrEqual(0);
    expect(cupo.disponibles + cupo.tomados).toBe(cupo.totales);
    // Cada pasajero con asiento de la cadena tiene exactamente uno
    expect(ocupados).toHaveLength(cupo.tomados);
  });
});

describe('Pago pendiente que la Payment API rechaza después', () => {
  const pagos: ServicioPagos = {
    autorizar: () => Promise.resolve('PENDIENTE'),
    consultar: () => Promise.resolve('RECHAZADO'),
    reembolsar: () => Promise.resolve('APROBADO'),
    consultarReembolso: () => Promise.resolve('APROBADO'),
  };
  let app: INestApplication;
  let prisma: PrismaService;
  let cliente: Cliente;

  beforeAll(async () => {
    app = await crearApp([], { reemplazos: [{ proveedor: SERVICIO_PAGOS, valor: pagos }] });
    prisma = app.get(PrismaService);
    cliente = await nuevoCliente(app);
  });
  afterAll(async () => {
    await desactivarUsuariosDePrueba(app);
    await app.close();
  });

  it('la reserva FALLA: boletos FAILED, asientos libres, cupo devuelto y el hold sigue CONSUMIDA', async () => {
    const retenido = await soloIda(app, cliente, 50);
    const salida = retenido.oferta.itineraries[0].segments[0].segmentId;
    const antes = await cupoDe(prisma, salida);
    const respuesta = await reservar(
      app,
      cliente.token,
      cuerpoReserva(retenido.holdId, [pasajero('ADULT', 1)]),
    ).expect(202);
    expect((await app.get(EmisionPendiente).ejecutar()).fallidas).toBeGreaterThanOrEqual(1);
    const detalle = await con(app, cliente.token)(
      'get',
      `${RESERVAS}/${respuesta.body.bookingId}`,
    ).expect(200);
    esperarContrato('BookingDetail', detalle.body);
    expect(detalle.body).toMatchObject({ status: 'FAILED' });
    expect(detalle.body.tickets[0]).toMatchObject({
      status: 'FAILED',
      failureReason: 'The payment was not authorized',
    });
    expect(detalle.body.passengers[0].assignedSeats).toEqual([]);
    expect(await estadoHold(prisma, retenido.holdId)).toBe('CONSUMIDA');
    expect((await cupoDe(prisma, salida)).disponibles).toBe(antes.disponibles + 1);
  });
});

describe('PNR que choca', () => {
  let app: INestApplication;
  let cliente: Cliente;
  let existente: string;
  const generador = new GeneradorCodigos();
  const pnrs: string[] = [];
  const conChoque = Object.assign(Object.create(GeneradorCodigos.prototype), {
    pnr: () => pnrs.shift() ?? generador.pnr(),
    serieBoleto: () => generador.serieBoleto(),
  });

  beforeAll(async () => {
    app = await crearApp([], { reemplazos: [{ proveedor: GeneradorCodigos, valor: conChoque }] });
    cliente = await nuevoCliente(app);
    const primera = await soloIda(app, cliente, 51);
    existente = (
      await reservar(
        app,
        cliente.token,
        cuerpoReserva(primera.holdId, [pasajero('ADULT', 1)]),
      ).expect(201)
    ).body.pnr;
  });
  afterAll(async () => {
    await desactivarUsuariosDePrueba(app);
    await app.close();
  });

  it('si el PNR generado ya existe, se prueba otro sin fallar la reserva', async () => {
    pnrs.push(existente, existente);
    const retenido = await soloIda(app, cliente, 52);
    const respuesta = await reservar(
      app,
      cliente.token,
      cuerpoReserva(retenido.holdId, [pasajero('ADULT', 1)]),
    ).expect(201);
    expect(respuesta.body.pnr).not.toBe(existente);
    expect(pnrs).toEqual([]);
  });
});

describe('Seguridad de /bookings', () => {
  let app: INestApplication;
  let cliente: Cliente;

  beforeAll(async () => {
    app = await crearApp();
    cliente = await nuevoCliente(app);
  });
  afterAll(async () => {
    await desactivarUsuariosDePrueba(app);
    await app.close();
  });

  const id = randomUUID();
  const rutas: Array<['get' | 'post', string, string]> = [
    ['post', RESERVAS, 'flights:book'],
    ['get', RESERVAS, 'flights:read'],
    ['get', `${RESERVAS}/${id}`, 'flights:read'],
    ['get', `${RESERVAS}/${id}/tickets`, 'flights:read'],
    ['get', `${RESERVAS}/${id}/tickets/${id}`, 'flights:read'],
  ];

  it('sin token: 401 en las cinco operaciones', async () => {
    for (const [metodo, ruta] of rutas) {
      const respuesta = await con(app)(metodo, ruta).set('Idempotency-Key', randomUUID()).send({});
      expect(respuesta.status).toBe(401);
      esperarProblemDetails(respuesta);
    }
  });

  it('sin el scope de la operación: 403 diciendo cuál falta', async () => {
    for (const [metodo, ruta, scope] of rutas) {
      const otroScope = scope === 'flights:book' ? 'flights:read' : 'flights:book';
      const token = firmarToken(app, { scope: otroScope }, { subject: cliente.id, expiresIn: 60 });
      const respuesta = await con(app, token)(metodo, ruta)
        .set('Idempotency-Key', randomUUID())
        .send({});
      expect(respuesta.status).toBe(403);
      expect(respuesta.body.detail).toContain(scope);
    }
  });
});

describe('Límite de POST /bookings', () => {
  let app: INestApplication;
  let cliente: Cliente;

  beforeAll(async () => {
    app = await crearApp();
    cliente = await nuevoCliente(app);
  });
  afterAll(async () => {
    await desactivarUsuariosDePrueba(app);
    await app.close();
  });

  it('10 reservas por minuto e IP; la siguiente es 429 con Retry-After (las consultas no lo gastan)', async () => {
    const cuerpo = cuerpoReserva(randomUUID(), [pasajero('ADULT', 1)]);
    for (let i = 0; i < 10; i++)
      expect((await reservar(app, cliente.token, cuerpo)).status).toBe(422);
    const excedida = await reservar(app, cliente.token, cuerpo);
    expect(excedida.status).toBe(429);
    esperarProblemDetails(excedida);
    expect(excedida.body.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(Number(excedida.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect((await con(app, cliente.token)('get', RESERVAS)).status).toBe(200);
  });
});
