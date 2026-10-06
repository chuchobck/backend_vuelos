import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CodigoPase } from '../src/modules/vuelos/operaciones/pase-abordar/codigo-pase';
import { PrismaService } from '../src/prisma/prisma.service';
import { desactivarUsuariosDePrueba, firmarToken } from './utils/auth';
import { CadenaBusqueda, crearCadena, darDeBajaCadena, fechaEn } from './utils/busqueda';
import { ADMIN, AppCatalogo, crearAppCatalogo, enDias } from './utils/catalogo';
import { erroresContraContrato } from './utils/contrato';
import { crearApp } from './utils/crear-app';
import { LimitesReiniciables } from './utils/limites';
import { esperarProblemDetails } from './utils/problem-details';
import { RelojDePrueba } from './utils/reloj';
import {
  buscarYRetener,
  con,
  cuerpoReserva,
  nuevoCliente,
  pasajero,
  referenciaPago,
  reservar,
  RESERVAS,
} from './utils/reserva';

type Cliente = { id: string; token: string };
type Cuerpo = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- se valida con Ajv

const HORA = 3_600_000;
const MINUTO = 60_000;
const CHECKIN = (id: string) => `${RESERVAS}/${id}/check-in`;
const PASES = (id: string) => `${RESERVAS}/${id}/boarding-passes`;
const ESTADO = (numero: string, fecha: string) =>
  `/flights/v1/flights/${numero}/status?date=${fecha}`;

const esperarContrato = (esquema: string, cuerpo: unknown) =>
  expect(erroresContraContrato(esquema, cuerpo)).toEqual([]);

/** La salida programada del segmento `i` de la reserva. */
const salidaDe = (detalle: Cuerpo, i = 0) =>
  new Date(detalle.itineraries[i].segments[0].departure.at);

/** Una reserva confirmada UIO-GYE de ida (o ida y vuelta) en la semilla; el reloj queda en el presente. */
async function reservaEn(
  app: INestApplication,
  cliente: Cliente,
  dias: number,
  pasajeros: object[] = [pasajero('ADULT', 1)],
  opciones: { vuelta?: number; fareBrand?: string; referencia?: string } = {},
): Promise<Cuerpo> {
  const breakdown = {
    adults: pasajeros.filter((p) => (p as { passengerType: string }).passengerType === 'ADULT')
      .length,
    infants: pasajeros.filter((p) => (p as { passengerType: string }).passengerType === 'INFANT')
      .length,
  };
  const tramos: Array<[string, string, string]> = [['UIO', 'GYE', fechaEn(dias)]];
  if (opciones.vuelta) tramos.push(['GYE', 'UIO', fechaEn(dias + opciones.vuelta)]);
  const retenido = await buscarYRetener(app, cliente.token, tramos, breakdown, {
    directa: true,
    fareBrand: opciones.fareBrand,
  });
  const respuesta = await reservar(
    app,
    cliente.token,
    cuerpoReserva(retenido.holdId, pasajeros, opciones.referencia ?? referenciaPago()),
  );
  expect([201, 202]).toContain(respuesta.status);
  return respuesta.body;
}

describe('Check-in y pases de abordar sobre la semilla', () => {
  const reloj = new RelojDePrueba();
  const limites = new LimitesReiniciables();
  let app: INestApplication;
  let prisma: PrismaService;
  let cliente: Cliente;
  let otro: Cliente;

  const hacer = (quien: Cliente, id: string) => con(app, quien.token)('post', CHECKIN(id));
  const pases = (quien: Cliente, id: string) => con(app, quien.token)('get', PASES(id));
  const registros = (id: string) =>
    prisma.db.checkin.count({ where: { reserva_detalle_pasajero: { reserva_id: id } } });
  const cantidadDePases = (id: string) =>
    prisma.db.pase_abordar.count({
      where: { checkin: { reserva_detalle_pasajero: { reserva_id: id } } },
    });
  const eventos = async (id: string) =>
    (
      await prisma.db.reserva_detalle_historial.findMany({
        where: { reserva_id: id, descripcion: { startsWith: 'Check-in for flight' } },
      })
    ).length;

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

  describe('check-in feliz con un infante', () => {
    let reserva: Cuerpo;
    let respuesta: Cuerpo;
    const adulto1 = pasajero('ADULT', 1);
    const adulto2 = pasajero('ADULT', 2);
    const infante = pasajero('INFANT', 3, { associatedAdultId: adulto1.passengerId });

    beforeAll(async () => {
      reloj.alPresente();
      reserva = await reservaEn(app, cliente, 12, [adulto1, adulto2, infante]);
      reloj.fijar(new Date(salidaDe(reserva).getTime() - 24 * HORA));
      respuesta = (await hacer(cliente, reserva.bookingId).expect(200)).body;
    });

    it('200 que cumple CheckInResponse: COMPLETED, el asiento de la reserva y el infante sin asiento', () => {
      esperarContrato('CheckInResponse', respuesta);
      expect(respuesta.status).toBe('COMPLETED');
      const porId = Object.fromEntries(
        respuesta.checkedInPassengers.map((p: Cuerpo) => [p.passengerId, p]),
      );
      const segmento = reserva.itineraries[0].segments[0].segmentId;
      for (const [id, i] of [
        ['ADU1', 0],
        ['ADU2', 1],
      ] as const) {
        expect(porId[id]).toEqual({
          passengerId: id,
          status: 'CHECKED_IN',
          segments: [
            {
              segmentId: segmento,
              seat: reserva.passengers[i].assignedSeats[0].seatNumber,
              status: 'CHECKED_IN',
            },
          ],
        });
      }
      expect(porId.INF3.segments).toEqual([
        { segmentId: segmento, seat: null, status: 'CHECKED_IN' },
      ]);
    });

    it('guarda un registro por pasajero (también el infante), un evento en el historial y la auditoría con el dueño', async () => {
      expect(await registros(reserva.bookingId)).toBe(3);
      const detalle = await con(app, cliente.token)(
        'get',
        `${RESERVAS}/${reserva.bookingId}`,
      ).expect(200);
      expect(detalle.body.changes.at(-1).description).toBe(
        'Check-in for flight LA1400: 3 passenger(s)'.replace(
          'LA1400',
          reserva.itineraries[0].segments[0].flightNumber,
        ),
      );
      const auditoria = await prisma.db.auditoria.findMany({
        where: { nombre_tabla: 'checkin' },
        orderBy: { id: 'desc' },
        take: 3,
      });
      expect(auditoria.every((a) => a.id_usuario === cliente.id)).toBe(true);
    });

    it('repetir el check-in no cambia nada: el mismo resultado, los mismos registros, pases y eventos', async () => {
      const antes = {
        registros: await registros(reserva.bookingId),
        pases: await cantidadDePases(reserva.bookingId),
        eventos: await eventos(reserva.bookingId),
      };
      const repetida = await hacer(cliente, reserva.bookingId).expect(200);
      expect(repetida.body).toEqual(respuesta);
      expect({
        registros: await registros(reserva.bookingId),
        pases: await cantidadDePases(reserva.bookingId),
        eventos: await eventos(reserva.bookingId),
      }).toEqual(antes);
      expect(antes).toEqual({ registros: 3, pases: 2, eventos: 1 });
    });

    it('la reserva de otro usuario o inexistente: 404', async () => {
      for (const id of [reserva.bookingId, randomUUID()]) {
        const r = await hacer(otro, id);
        expect(r.status).toBe(404);
        esperarProblemDetails(r);
      }
      expect((await pases(otro, reserva.bookingId)).status).toBe(404);
    });
  });

  describe('ventana y elegibilidad', () => {
    it('antes de abrir: 409 CHECK_IN_NOT_AVAILABLE diciendo cuándo abre; después de cerrar o despegado, 409', async () => {
      const reserva = await reservaEn(app, cliente, 14);
      const salida = salidaDe(reserva);
      const antes = await hacer(cliente, reserva.bookingId);
      expect(antes.status).toBe(409);
      esperarProblemDetails(antes);
      expect(antes.body.code).toBe('CHECK_IN_NOT_AVAILABLE');
      expect(antes.body.detail).toContain(new Date(salida.getTime() - 48 * HORA).toISOString());

      for (const instante of [salida.getTime() - 30 * MINUTO, salida.getTime() + HORA]) {
        reloj.fijar(new Date(instante));
        const cerrada = await hacer(cliente, reserva.bookingId);
        expect(cerrada.status).toBe(409);
        expect(cerrada.body.code).toBe('CHECK_IN_NOT_AVAILABLE');
        expect(cerrada.body.detail).toMatch(/closed/);
      }
      expect(await registros(reserva.bookingId)).toBe(0);
    });

    it('el borde de la ventana: abre justo 48 h antes y cierra justo 60 minutos antes', async () => {
      // Las dos reservas primero: con el reloj adelantado la oferta de la búsqueda ya venció
      const reserva = await reservaEn(app, cliente, 15);
      const otraReserva = await reservaEn(app, cliente, 15);
      const salida = salidaDe(reserva).getTime();
      reloj.fijar(new Date(salida - 48 * HORA - 1000));
      expect((await hacer(cliente, reserva.bookingId)).status).toBe(409);
      reloj.fijar(new Date(salida - 60 * MINUTO - 1000));
      expect((await hacer(cliente, reserva.bookingId)).status).toBe(200);
      reloj.fijar(new Date(salida - 60 * MINUTO));
      expect((await hacer(cliente, otraReserva.bookingId)).status).toBe(409);
    });

    it('una reserva cancelada: 409 que dice su estado', async () => {
      const reserva = await reservaEn(app, cliente, 16);
      const cotizacion = await con(app, cliente.token)(
        'get',
        `${RESERVAS}/${reserva.bookingId}/cancellation-quote`,
      ).expect(200);
      await con(app, cliente.token)('post', `${RESERVAS}/${reserva.bookingId}/cancel`)
        .set('Idempotency-Key', randomUUID())
        .send({ quoteId: cotizacion.body.quoteId })
        .expect(200);
      reloj.fijar(new Date(salidaDe(reserva).getTime() - 24 * HORA));
      const respuesta = await hacer(cliente, reserva.bookingId);
      expect(respuesta.status).toBe(409);
      esperarProblemDetails(respuesta);
      expect(respuesta.body.code).toBe('CHECK_IN_NOT_AVAILABLE');
      expect(respuesta.body.detail).toMatch(/CANCELLED/);
    });

    it('una reserva con el pago pendiente: 409 PENDING_PAYMENT', async () => {
      const reserva = await reservaEn(app, cliente, 17, [pasajero('ADULT', 1)], {
        referencia: referenciaPago('PEND'),
      });
      expect(reserva.status).toBe('PENDING_PAYMENT');
      reloj.fijar(new Date(salidaDe(reserva).getTime() - 24 * HORA));
      const respuesta = await hacer(cliente, reserva.bookingId);
      expect(respuesta.status).toBe(409);
      expect(respuesta.body.detail).toMatch(/PENDING_PAYMENT/);
    });

    it('un vuelo cancelado por la aerolínea: 409 y no registra nada', async () => {
      const reserva = await reservaEn(app, cliente, 18);
      const segmento = reserva.itineraries[0].segments[0].segmentId;
      await prisma.db
        .$executeRaw`UPDATE vuelos.vuelo_programado SET estado = 'CANCELADO' WHERE id = ${segmento}::uuid`;
      try {
        reloj.fijar(new Date(salidaDe(reserva).getTime() - 24 * HORA));
        const respuesta = await hacer(cliente, reserva.bookingId);
        expect(respuesta.status).toBe(409);
        expect(await registros(reserva.bookingId)).toBe(0);
      } finally {
        await prisma.db
          .$executeRaw`UPDATE vuelos.vuelo_programado SET estado = 'PROGRAMADO' WHERE id = ${segmento}::uuid`;
      }
    });

    it('un pasaporte que vence antes del vuelo: 422 CHECK_IN_FAILED que nombra el campo y no registra nada', async () => {
      const documento = 'AB123456';
      const reserva = await reservaEn(app, cliente, 19, [
        pasajero('ADULT', 1, {
          documentType: 'PASSPORT',
          documentNumber: documento,
          documentExpiryDate: fechaEn(800),
        }),
      ]);
      await prisma.db
        .$executeRaw`UPDATE vuelos.reserva_detalle_pasajero SET fecha_vencimiento_documento = DATE '2020-01-01' WHERE reserva_id = ${reserva.bookingId}::uuid`;
      reloj.fijar(new Date(salidaDe(reserva).getTime() - 24 * HORA));
      const respuesta = await hacer(cliente, reserva.bookingId);
      expect(respuesta.status).toBe(422);
      esperarProblemDetails(respuesta);
      expect(respuesta.body.code).toBe('CHECK_IN_FAILED');
      expect(respuesta.body.invalidParams).toEqual([
        { name: 'passengers[0].documentExpiryDate', reason: expect.any(String) },
      ]);
      expect(JSON.stringify(respuesta.body)).not.toContain(documento);
      expect(await registros(reserva.bookingId)).toBe(0);
    });

    it('un pasajero sin asiento asignado: 422 CHECK_IN_FAILED', async () => {
      const reserva = await reservaEn(app, cliente, 20);
      await prisma.db.$executeRaw`
        UPDATE vuelos.reserva_detalle_asiento SET fecha_liberacion = now()
         WHERE pasajero_id IN (SELECT id FROM vuelos.reserva_detalle_pasajero WHERE reserva_id = ${reserva.bookingId}::uuid)`;
      reloj.fijar(new Date(salidaDe(reserva).getTime() - 24 * HORA));
      const respuesta = await hacer(cliente, reserva.bookingId);
      expect(respuesta.status).toBe(422);
      expect(respuesta.body.invalidParams[0].name).toBe('passengers[0].seat');
    });
  });

  describe('resultado parcial por segmentos', () => {
    it('ida y vuelta: la vuelta todavía no abre. IN_PROGRESS ahora y COMPLETED cuando abre', async () => {
      const reserva = await reservaEn(app, cliente, 25, [pasajero('ADULT', 1)], { vuelta: 3 });
      const [ida, vuelta] = reserva.itineraries.map((it: Cuerpo) => it.segments[0].segmentId);
      reloj.fijar(new Date(salidaDe(reserva, 0).getTime() - 24 * HORA));
      const parcial = await hacer(cliente, reserva.bookingId).expect(200);
      esperarContrato('CheckInResponse', parcial.body);
      expect(parcial.body.status).toBe('IN_PROGRESS');
      expect(parcial.body.checkedInPassengers[0].status).toBe('NOT_CHECKED_IN');
      expect(
        parcial.body.checkedInPassengers[0].segments.map((s: Cuerpo) => [s.segmentId, s.status]),
      ).toEqual([
        [ida, 'CHECKED_IN'],
        [vuelta, 'NOT_CHECKED_IN'],
      ]);
      expect(
        (await pases(cliente, reserva.bookingId).expect(200)).body.boardingPasses,
      ).toHaveLength(1);

      reloj.fijar(new Date(salidaDe(reserva, 1).getTime() - 24 * HORA));
      const completo = await hacer(cliente, reserva.bookingId).expect(200);
      expect(completo.body.status).toBe('COMPLETED');
      expect(completo.body.checkedInPassengers[0].segments.map((s: Cuerpo) => s.status)).toEqual([
        'CHECKED_IN',
        'CHECKED_IN',
      ]);
      expect(await registros(reserva.bookingId)).toBe(2);
      expect(
        (await pases(cliente, reserva.bookingId).expect(200)).body.boardingPasses,
      ).toHaveLength(2);
    });

    it('ida y vuelta: la ida ya cerró y la vuelta está abierta. La ida queda FAILED y el resultado es parcial', async () => {
      const reserva = await reservaEn(app, cliente, 26, [pasajero('ADULT', 1)], { vuelta: 1 });
      const [ida, vuelta] = reserva.itineraries.map((it: Cuerpo) => it.segments[0].segmentId);
      reloj.fijar(new Date(salidaDe(reserva, 0).getTime() - 30 * MINUTO));
      const respuesta = await hacer(cliente, reserva.bookingId).expect(200);
      esperarContrato('CheckInResponse', respuesta.body);
      expect(respuesta.body.status).toBe('IN_PROGRESS');
      expect(respuesta.body.checkedInPassengers[0].status).toBe('FAILED');
      expect(
        respuesta.body.checkedInPassengers[0].segments.map((s: Cuerpo) => [s.segmentId, s.status]),
      ).toEqual([
        [ida, 'FAILED'],
        [vuelta, 'CHECKED_IN'],
      ]);
      expect(await registros(reserva.bookingId)).toBe(1);
      expect(
        (await pases(cliente, reserva.bookingId).expect(200)).body.boardingPasses.map(
          (p: Cuerpo) => p.segmentId,
        ),
      ).toEqual([vuelta]);
    });

    it('con las dos ventanas abiertas se registran los dos vuelos en un solo check-in', async () => {
      const reserva = await reservaEn(
        app,
        cliente,
        27,
        [pasajero('ADULT', 1), pasajero('ADULT', 2)],
        { vuelta: 1 },
      );
      // Dos horas antes de la ida: dentro de su ventana y de la de la vuelta (sale a lo sumo 48 h después)
      reloj.fijar(new Date(salidaDe(reserva, 0).getTime() - 2 * HORA));
      const respuesta = await hacer(cliente, reserva.bookingId).expect(200);
      expect(respuesta.body.status).toBe('COMPLETED');
      expect(await registros(reserva.bookingId)).toBe(4);
      expect(await cantidadDePases(reserva.bookingId)).toBe(4);
      expect(await eventos(reserva.bookingId)).toBe(2);
    });
  });

  describe('pases de abordar', () => {
    it('sin check-in: 200 con la lista vacía', async () => {
      const reserva = await reservaEn(app, cliente, 30);
      const respuesta = await pases(cliente, reserva.bookingId).expect(200);
      esperarContrato('BoardingPassListResponse', respuesta.body);
      expect(respuesta.body).toEqual({ bookingId: reserva.bookingId, boardingPasses: [] });
    });

    it('con check-in: un pase por pasajero con asiento, sin el infante, con código firmado y sin datos personales', async () => {
      const adulto1 = pasajero('ADULT', 1);
      const adulto2 = pasajero('ADULT', 2);
      const infante = pasajero('INFANT', 3, { associatedAdultId: adulto1.passengerId });
      const reserva = await reservaEn(app, cliente, 31, [adulto1, adulto2, infante]);
      reloj.fijar(new Date(salidaDe(reserva).getTime() - 24 * HORA));
      await hacer(cliente, reserva.bookingId).expect(200);
      const respuesta = await pases(cliente, reserva.bookingId).expect(200);
      esperarContrato('BoardingPassListResponse', respuesta.body);
      const lista: Cuerpo[] = respuesta.body.boardingPasses;
      expect(lista.map((p) => p.passengerId)).toEqual(['ADU1', 'ADU2']);
      const codigo = app.get(CodigoPase);
      for (const [i, pase] of lista.entries()) {
        const asiento = reserva.passengers[i].assignedSeats[0].seatNumber;
        expect(pase).toMatchObject({
          segmentId: reserva.itineraries[0].segments[0].segmentId,
          seat: asiento,
          boardingGroup: '3',
          boardingPosition: asiento.replace(/[A-Z]$/, '').padStart(3, '0'),
          barcodeType: 'PDF417',
        });
        expect(codigo.verificar(pase.barcode)).toEqual({
          pnr: reserva.pnr,
          numeroBoleto: reserva.tickets[i].eTicketNumber,
          numeroVuelo: reserva.itineraries[0].segments[0].flightNumber,
          fechaSalida: fechaEn(31),
          origen: 'UIO',
          destino: 'GYE',
          asiento,
          secuencia: i + 1,
        });
        // Nada personal en el código
        for (const dato of [
          reserva.passengers[i].documentNumber,
          reserva.passengers[i].firstName,
          reserva.passengers[i].lastName,
          reserva.passengers[i].contact.email,
        ]) {
          expect(pase.barcode).not.toContain(dato);
        }
      }
      expect(new Set(lista.map((p) => p.barcode)).size).toBe(2);
      // Un código manipulado no verifica
      expect(codigo.verificar(lista[0].barcode.replace(`|${lista[0].seat}|`, '|99Z|'))).toBeNull();
      expect(
        codigo.verificar(
          lista[0].barcode.slice(0, -1) + (lista[0].barcode.endsWith('0') ? '1' : '0'),
        ),
      ).toBeNull();
    });

    it('son estables: pedirlos dos veces, o repetir el check-in, devuelve exactamente lo mismo', async () => {
      const reserva = await reservaEn(app, cliente, 32, [pasajero('ADULT', 1)]);
      reloj.fijar(new Date(salidaDe(reserva).getTime() - 24 * HORA));
      await hacer(cliente, reserva.bookingId).expect(200);
      const primera = await pases(cliente, reserva.bookingId).expect(200);
      const segunda = await pases(cliente, reserva.bookingId).expect(200);
      await hacer(cliente, reserva.bookingId).expect(200);
      const tercera = await pases(cliente, reserva.bookingId).expect(200);
      expect(segunda.body).toEqual(primera.body);
      expect(tercera.body).toEqual(primera.body);
    });

    it('en ejecutiva: grupo 1 y código AZTEC', async () => {
      const reserva = await reservaEn(app, cliente, 33, [pasajero('ADULT', 1)], {
        fareBrand: 'BUSINESS_FLEX',
      });
      reloj.fijar(new Date(salidaDe(reserva).getTime() - 24 * HORA));
      await hacer(cliente, reserva.bookingId).expect(200);
      const [pase] = (await pases(cliente, reserva.bookingId).expect(200)).body.boardingPasses;
      expect(pase).toMatchObject({ boardingGroup: '1', barcodeType: 'AZTEC' });
      expect(Number(pase.seat.replace(/[A-Z]$/, ''))).toBeLessThanOrEqual(3);
    });

    it('una reserva cancelada después del check-in ya no tiene pases válidos', async () => {
      const reserva = await reservaEn(app, cliente, 34);
      reloj.fijar(new Date(salidaDe(reserva).getTime() - 24 * HORA));
      await hacer(cliente, reserva.bookingId).expect(200);
      expect(
        (await pases(cliente, reserva.bookingId).expect(200)).body.boardingPasses,
      ).toHaveLength(1);
      reloj.alPresente();
      const cotizacion = await con(app, cliente.token)(
        'get',
        `${RESERVAS}/${reserva.bookingId}/cancellation-quote`,
      ).expect(200);
      await con(app, cliente.token)('post', `${RESERVAS}/${reserva.bookingId}/cancel`)
        .set('Idempotency-Key', randomUUID())
        .send({ quoteId: cotizacion.body.quoteId })
        .expect(200);
      expect((await pases(cliente, reserva.bookingId).expect(200)).body.boardingPasses).toEqual([]);
    });
  });

  describe('concurrencia', () => {
    it('8 check-in simultáneos de la misma reserva: un solo registro por pasajero y vuelo, un evento por vuelo', async () => {
      const adulto1 = pasajero('ADULT', 1);
      const reserva = await reservaEn(
        app,
        cliente,
        40,
        [
          adulto1,
          pasajero('ADULT', 2),
          pasajero('INFANT', 3, { associatedAdultId: adulto1.passengerId }),
        ],
        { vuelta: 1 },
      );
      reloj.fijar(new Date(salidaDe(reserva, 0).getTime() - 2 * HORA));
      const respuestas = await Promise.all(
        Array.from({ length: 8 }, () => hacer(cliente, reserva.bookingId)),
      );
      expect(respuestas.map((r) => r.status)).toEqual(Array(8).fill(200));
      for (const r of respuestas) expect(r.body).toEqual(respuestas[0].body);
      expect(respuestas[0].body.status).toBe('COMPLETED');
      // 3 pasajeros x 2 vuelos
      expect(await registros(reserva.bookingId)).toBe(6);
      expect(await cantidadDePases(reserva.bookingId)).toBe(4);
      expect(await eventos(reserva.bookingId)).toBe(2);
      const duplicados = await prisma.db.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM (
          SELECT c.pasajero_id, c.vuelo_programado_id FROM vuelos.checkin c
            JOIN vuelos.reserva_detalle_pasajero p ON p.id = c.pasajero_id
           WHERE p.reserva_id = ${reserva.bookingId}::uuid AND c.estado = 'REGISTRADO'
           GROUP BY 1, 2 HAVING count(*) > 1) x`;
      expect(duplicados[0].n).toBe(0);
    });
  });
});

describe('Estado de vuelo', () => {
  describe('sobre la semilla', () => {
    let app: INestApplication;
    beforeAll(async () => {
      app = await crearApp();
    });
    afterAll(async () => {
      await app.close();
    });
    const consultar = (numero: string, fecha: string) => con(app)('get', ESTADO(numero, fecha));

    it('sin token: 200 FlightStatus con las horas de la salida programada en UTC y los datos opcionales en null', async () => {
      const dia = fechaEn(10);
      const busqueda = await con(app)('post', '/flights/v1/search')
        .set('X-Device-Fingerprint', 'e2e-estado-vuelo-1')
        .send({
          itineraries: [{ origin: 'UIO', destination: 'GYE', departureDate: dia }],
          passengers: {},
        })
        .expect(200);
      const segmento = busqueda.body.offers.find(
        (o: Cuerpo) => o.itineraries[0].segments.length === 1,
      ).itineraries[0].segments[0];
      const respuesta = await consultar(segmento.flightNumber, dia).expect(200);
      esperarContrato('FlightStatus', respuesta.body);
      expect(respuesta.body).toEqual({
        flightNumber: segmento.flightNumber,
        date: dia,
        marketingCarrier: segmento.marketingCarrier,
        operatingCarrier: segmento.operatingCarrier,
        departure: {
          iataCode: 'UIO',
          terminal: null,
          scheduledAt: segmento.departure.at,
          estimatedAt: null,
          actualAt: null,
        },
        arrival: {
          iataCode: 'GYE',
          terminal: null,
          scheduledAt: segmento.arrival.at,
          estimatedAt: null,
          actualAt: null,
        },
        aircraft: segmento.aircraft,
        status: 'SCHEDULED',
      });
    });

    it('no trae datos de reservas ni de pasajeros', async () => {
      const respuesta = await consultar('LA1400', fechaEn(10));
      const texto = JSON.stringify(respuesta.body);
      expect(texto).not.toMatch(/passenger|booking|pnr|ticket|seat/i);
      expect(Object.keys(respuesta.body).sort()).toEqual([
        'aircraft',
        'arrival',
        'date',
        'departure',
        'flightNumber',
        'marketingCarrier',
        'operatingCarrier',
        'status',
      ]);
    });

    it('un vuelo que no existe en esa fecha: 404 ProblemDetails', async () => {
      for (const [numero, fecha] of [
        ['LA9999', fechaEn(10)],
        ['LA1400', '2020-01-01'],
      ]) {
        const respuesta = await consultar(numero, fecha);
        expect(respuesta.status).toBe(404);
        esperarProblemDetails(respuesta);
      }
    });

    it.each([
      [
        'un número que no es de una aerolínea',
        '/flights/v1/flights/XX/status?date=2026-10-20',
        'flightNumber',
      ],
      [
        'un número con minúsculas',
        '/flights/v1/flights/la1400/status?date=2026-10-20',
        'flightNumber',
      ],
      [
        'un número demasiado largo',
        '/flights/v1/flights/LA12345/status?date=2026-10-20',
        'flightNumber',
      ],
      ['sin fecha', '/flights/v1/flights/LA1400/status', 'date'],
      ['una fecha que no existe', '/flights/v1/flights/LA1400/status?date=2026-02-30', 'date'],
      ['una fecha con otro formato', '/flights/v1/flights/LA1400/status?date=20-10-2026', 'date'],
    ])('%s: 400 VALIDATION_FAILED', async (_caso, ruta, campo) => {
      const respuesta = await con(app)('get', ruta);
      expect(respuesta.status).toBe(400);
      esperarProblemDetails(respuesta);
      expect(respuesta.body.invalidParams.map((p: { name: string }) => p.name)).toEqual([campo]);
    });
  });

  describe('sobre un catálogo propio', () => {
    const limites = new LimitesReiniciables();
    let c: AppCatalogo;
    let k: CadenaBusqueda;
    const extras: string[] = [];

    beforeAll(async () => {
      c = await crearAppCatalogo({ limites });
      k = await crearCadena(c);
    });
    afterAll(async () => {
      for (const id of extras) await c.admin('delete', `${ADMIN}/departures/${id}`).expect(204);
      await darDeBajaCadena(c, k);
      await c.cerrar();
    });

    it('con demora: DELAYED, la hora estimada y el terminal, en UTC', async () => {
      await c
        .admin('patch', `${ADMIN}/departures/${k.salida}`, {
          status: 'DELAYED',
          estimatedDeparture: enDias(20, 15, 40),
          estimatedArrival: enDias(20, 16, 40),
          departureTerminal: 'B',
        })
        .expect(200);
      const respuesta = await con(c.app)('get', ESTADO(k.vuelo, k.fecha)).expect(200);
      esperarContrato('FlightStatus', respuesta.body);
      expect(respuesta.body.status).toBe('DELAYED');
      expect(respuesta.body.departure).toEqual({
        iataCode: k.origen,
        terminal: 'B',
        scheduledAt: enDias(20, 15),
        estimatedAt: enDias(20, 15, 40),
        actualAt: null,
      });
      expect(respuesta.body.arrival.estimatedAt).toBe(enDias(20, 16, 40));
    });

    it('cancelado: CANCELLED y sigue consultable', async () => {
      const salida = await c
        .admin('post', `${ADMIN}/departures`, {
          flightNumber: k.vuelo,
          seatMapId: k.mapa,
          scheduledDeparture: enDias(21, 15),
          scheduledArrival: enDias(21, 16),
          cabins: [{ cabinClass: 'ECONOMY', totalSeats: 2 }],
        })
        .expect(201);
      extras.push(salida.body.id);
      await c.admin('delete', `${ADMIN}/departures/${salida.body.id}`).expect(204);
      const respuesta = await con(c.app)('get', ESTADO(k.vuelo, salida.body.departureDate)).expect(
        200,
      );
      esperarContrato('FlightStatus', respuesta.body);
      expect(respuesta.body.status).toBe('CANCELLED');
    });

    it('Galápagos: la fecha es la local del origen (UTC−6) y las horas salen en UTC', async () => {
      const ciudad = (await c.admin('get', `${ADMIN}/airports/${k.origen}`).expect(200)).body
        .cityId;
      await c
        .admin('patch', `${ADMIN}/cities/${ciudad}`, { timeZone: 'Pacific/Galapagos' })
        .expect(200);
      // 03:00 UTC son las 21:00 del día anterior en Galápagos
      const salida = await c
        .admin('post', `${ADMIN}/departures`, {
          flightNumber: k.vuelo,
          seatMapId: k.mapa,
          scheduledDeparture: enDias(30, 3),
          scheduledArrival: enDias(30, 5),
          cabins: [{ cabinClass: 'ECONOMY', totalSeats: 2 }],
        })
        .expect(201);
      extras.push(salida.body.id);
      const local = salida.body.departureDate as string;
      const utc = enDias(30, 3).slice(0, 10);
      expect(local < utc).toBe(true);
      const respuesta = await con(c.app)('get', ESTADO(k.vuelo, local)).expect(200);
      esperarContrato('FlightStatus', respuesta.body);
      expect(respuesta.body.date).toBe(local);
      expect(respuesta.body.departure.scheduledAt).toBe(enDias(30, 3));
      expect((await con(c.app)('get', ESTADO(k.vuelo, utc))).status).toBe(404);
    });
  });
});

describe('Seguridad y límites del check-in y de los pases', () => {
  const limites = new LimitesReiniciables();
  let app: INestApplication;
  let cliente: Cliente;
  const id = randomUUID();

  beforeAll(async () => {
    app = await crearApp([], { limites });
    cliente = await nuevoCliente(app);
  });
  beforeEach(() => limites.reiniciar());
  afterAll(async () => {
    await desactivarUsuariosDePrueba(app);
    await app.close();
  });

  const rutas: Array<['get' | 'post', string, string]> = [
    ['post', CHECKIN(id), 'flights:book'],
    ['get', PASES(id), 'flights:read'],
  ];

  it('sin token: 401; con el scope de la otra operación: 403 diciendo cuál falta', async () => {
    for (const [metodo, ruta, scope] of rutas) {
      const sinToken = await con(app)(metodo, ruta);
      expect(sinToken.status).toBe(401);
      esperarProblemDetails(sinToken);
      const otro = scope === 'flights:read' ? 'flights:book' : 'flights:read';
      const token = firmarToken(app, { scope: otro }, { subject: cliente.id, expiresIn: 60 });
      const sinScope = await con(app, token)(metodo, ruta);
      expect(sinScope.status).toBe(403);
      expect(sinScope.body.detail).toContain(scope);
    }
  });

  it('un bookingId que no es uuid: 400', async () => {
    expect((await con(app, cliente.token)('post', `${RESERVAS}/no-es-uuid/check-in`)).status).toBe(
      400,
    );
    expect(
      (await con(app, cliente.token)('get', `${RESERVAS}/no-es-uuid/boarding-passes`)).status,
    ).toBe(400);
  });

  it('POST .../check-in: 20 por minuto e IP, después 429 con Retry-After', async () => {
    for (let i = 0; i < 20; i++)
      expect((await con(app, cliente.token)('post', CHECKIN(id))).status).toBe(404);
    const excedida = await con(app, cliente.token)('post', CHECKIN(id));
    expect(excedida.status).toBe(429);
    esperarProblemDetails(excedida);
    expect(excedida.body.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(Number(excedida.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('GET /flights/{flightNumber}/status: 60 por minuto e IP, después 429; los pases no lo gastan', async () => {
    for (let i = 0; i < 60; i++)
      expect((await con(app)('get', ESTADO('LA9999', '2026-10-20'))).status).toBe(404);
    const excedida = await con(app)('get', ESTADO('LA9999', '2026-10-20'));
    expect(excedida.status).toBe(429);
    expect(excedida.body.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(Number(excedida.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });
});
