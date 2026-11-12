import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { ES_LIMITE_ESTRICTO } from '../src/common/decorators/limite-peticiones.decorator';
import {
  ComparadorApellidos,
  normalizarApellido,
} from '../src/modules/vuelos/operaciones/kiosko/apellido';
import {
  KioskoController,
  LIMITES_KIOSKO,
} from '../src/modules/vuelos/operaciones/kiosko/kiosko.controller';
import { PrismaService } from '../src/prisma/prisma.service';
import { desactivarUsuariosDePrueba } from './utils/auth';
import { erroresContraContrato } from './utils/contrato';
import { crearApp } from './utils/crear-app';
import { LimitesReiniciables } from './utils/limites';
import { LogEnMemoria } from './utils/log-en-memoria';
import { esperarProblemDetails } from './utils/problem-details';
import { RelojDePrueba } from './utils/reloj';
import { con, nuevoCliente, pasajero, RESERVAS } from './utils/reserva';
import { Cliente, Cuerpo, reservaConfirmada, salidaDe, segmentoDe } from './utils/viaje';

const HORA = 3_600_000;
const MINUTO = 60_000;
const KIOSKO = '/flights/v1/kiosk';
const BUSQUEDA = `${KIOSKO}/lookup`;
const CHECKIN = (id: string) => `${KIOSKO}/bookings/${id}/check-in`;
const PASES = (id: string) => `${KIOSKO}/bookings/${id}/boarding-passes`;

describe('Kiosko de check-in sin cuenta (/kiosk)', () => {
  const reloj = new RelojDePrueba();
  const limites = new LimitesReiniciables();
  const log = new LogEnMemoria();
  let app: INestApplication;
  let prisma: PrismaService;
  let cliente: Cliente;

  // Apellidos propios de esta prueba: ninguna otra reserva de la base los tiene
  const APELLIDO_A = "D'Ávila Ñáñez";
  const APELLIDO_B = 'Quishpe Toaquiza';
  const titular = pasajero('ADULT', 1, { firstName: 'María José', lastName: APELLIDO_A });
  const acompanante = pasajero('ADULT', 2, { firstName: 'Segundo', lastName: APELLIDO_B });
  const bebe = pasajero('INFANT', 3, {
    firstName: 'Amaru',
    lastName: APELLIDO_B,
    associatedAdultId: titular.passengerId,
  });
  let reservaA: Cuerpo;
  let reservaB: Cuerpo;

  const http = () => request(app.getHttpServer());
  const buscar = (pnr: unknown, lastName: unknown) => http().post(BUSQUEDA).send({ pnr, lastName });
  const sesion = (token: string) => `Kiosk ${token}`;
  const hacerCheckin = (id: string, autorizacion?: string) => {
    const prueba = http().post(CHECKIN(id));
    return autorizacion === undefined ? prueba : prueba.set('Authorization', autorizacion);
  };
  const pases = (id: string, autorizacion?: string) => {
    const prueba = http().get(PASES(id));
    return autorizacion === undefined ? prueba : prueba.set('Authorization', autorizacion);
  };
  const registros = (id: string) =>
    prisma.db.checkin.count({ where: { reserva_detalle_pasajero: { reserva_id: id } } });

  /** Una sesión nueva de la reserva (con el reloj donde esté). */
  async function abrir(reserva: Cuerpo, apellido: string): Promise<Cuerpo> {
    limites.reiniciar();
    return (await buscar(reserva.pnr, apellido).expect(200)).body;
  }

  const esperarSesionInvalida = (respuesta: request.Response) => {
    expect([respuesta.status, respuesta.body.code]).toEqual([401, 'KIOSK_SESSION_INVALID']);
    esperarProblemDetails(respuesta);
    expect(respuesta.headers['www-authenticate']).toBe('Kiosk');
  };

  beforeAll(async () => {
    app = await crearApp([], { reloj, limites });
    app.useLogger(log);
    prisma = app.get(PrismaService);
    cliente = await nuevoCliente(app);
    reloj.alPresente();
    reservaA = await reservaConfirmada(app, cliente, 36, [titular, acompanante, bebe]);
    reservaB = await reservaConfirmada(app, cliente, 36, [
      pasajero('ADULT', 4, { firstName: 'Lucía', lastName: 'Zambrano Vélez' }),
    ]);
  });
  beforeEach(() => limites.reiniciar());
  afterAll(async () => {
    await desactivarUsuariosDePrueba(app);
    await app.close();
  });

  describe('búsqueda por PNR y apellido', () => {
    it('200 con la sesión y solo lo que el kiosko necesita', async () => {
      reloj.alPresente();
      const antes = reloj.ahora();
      const r = await buscar(reservaA.pnr, APELLIDO_A);
      expect(r.status).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
      const segmento = segmentoDe(reservaA);
      const salida = salidaDe(reservaA);
      expect(r.body).toEqual({
        kioskToken: expect.stringMatching(/^ksk1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
        expiresAt: expect.any(String),
        booking: {
          bookingId: reservaA.bookingId,
          status: 'CONFIRMED',
          passengers: [
            {
              passengerId: 'ADU1',
              passengerType: 'ADULT',
              firstName: 'María José',
              lastName: APELLIDO_A,
            },
            {
              passengerId: 'ADU2',
              passengerType: 'ADULT',
              firstName: 'Segundo',
              lastName: APELLIDO_B,
            },
            {
              passengerId: 'INF3',
              passengerType: 'INFANT',
              firstName: 'Amaru',
              lastName: APELLIDO_B,
            },
          ],
          flights: [
            {
              segmentId: segmento.segmentId,
              flightNumber: segmento.flightNumber,
              origin: 'UIO',
              destination: 'GYE',
              departureAt: segmento.departure.at,
              arrivalAt: segmento.arrival.at,
              departureTerminal: null,
              status: 'SCHEDULED',
              checkIn: {
                window: 'NOT_YET_OPEN',
                opensAt: new Date(salida.getTime() - 48 * HORA).toISOString(),
                closesAt: new Date(salida.getTime() - 60 * MINUTO).toISOString(),
              },
              passengers: [
                {
                  passengerId: 'ADU1',
                  seat: reservaA.passengers[0].assignedSeats[0].seatNumber,
                  checkInStatus: 'NOT_CHECKED_IN',
                },
                {
                  passengerId: 'ADU2',
                  seat: reservaA.passengers[1].assignedSeats[0].seatNumber,
                  checkInStatus: 'NOT_CHECKED_IN',
                },
                { passengerId: 'INF3', seat: null, checkInStatus: 'NOT_CHECKED_IN' },
              ],
            },
          ],
        },
      });
      // Vence a los 10 minutos del Reloj (en segundos enteros)
      const vence = new Date(r.body.expiresAt).getTime();
      expect(vence).toBe(Math.floor(antes.getTime() / 1000) * 1000 + 10 * MINUTO);
    });

    it('la respuesta no lleva documento, correo, teléfono, nacimiento, precio, boletos ni el PNR', async () => {
      const r = await buscar(reservaA.pnr, APELLIDO_A).expect(200);
      const texto = JSON.stringify(r.body);
      for (const p of [titular, acompanante, bebe]) {
        expect(texto).not.toContain(p.documentNumber);
        expect(texto).not.toContain(p.contact.email);
        expect(texto).not.toContain(p.contact.phone);
        expect(texto).not.toContain(p.birthDate);
      }
      expect(texto).not.toContain(reservaA.pnr);
      expect(texto).not.toContain(reservaA.tickets[0].eTicketNumber);
      expect(texto).not.toMatch(/total|fare|price|payment|email|phone|document/i);
    });

    it.each([
      ['tal cual', APELLIDO_A],
      ['en minúsculas y sin tildes ni apóstrofo', 'davila nanez'],
      ['en mayúsculas, con espacios de más', "  D ' AVILA   ÑAÑEZ "],
      ['con guion en vez de espacio', "D'Ávila-Ñáñez"],
      ['el de otro pasajero de la reserva', 'quishpe toaquiza'],
      ['con tildes donde no van', 'Quíshpe Tòaquiza'],
    ])('encuentra la reserva con el apellido %s', async (_caso, apellido) => {
      const r = await buscar(reservaA.pnr, apellido);
      expect(r.status).toBe(200);
      expect(r.body.booking.bookingId).toBe(reservaA.bookingId);
    });

    it('el PNR en minúsculas también sirve', async () => {
      const r = await buscar(reservaA.pnr.toLowerCase(), APELLIDO_A);
      expect(r.status).toBe(200);
    });

    it('sin enumeración: PNR inexistente, apellido errado, apellido de otra reserva y solo el primer apellido dan el mismo 404, byte a byte', async () => {
      const pnrLibre = 'ZZZZ99';
      expect(await prisma.db.reserva_cabecera.count({ where: { pnr: pnrLibre } })).toBe(0);
      const respuestas = [
        await buscar(pnrLibre, APELLIDO_A),
        await buscar(reservaA.pnr, 'Pérez'),
        await buscar(reservaA.pnr, 'Zambrano Vélez'),
        await buscar(reservaB.pnr, APELLIDO_A),
        await buscar(reservaA.pnr, "D'Ávila"),
        await buscar(reservaA.pnr, 'Quishpe'),
        await buscar(reservaA.pnr, `${APELLIDO_A} x`),
        await buscar(reservaA.pnr, '---'),
        await buscar(reservaA.pnr, 'María José'),
      ];
      for (const r of respuestas) {
        expect(r.status).toBe(404);
        esperarProblemDetails(r);
      }
      const cuerpos = new Set(respuestas.map((r) => r.text));
      expect([...cuerpos]).toEqual([
        JSON.stringify({
          type: 'https://api.booking-hub.com/errors/validation-failed',
          title: 'Not Found',
          status: 404,
          detail: 'Booking not found',
          code: 'VALIDATION_FAILED',
        }),
      ]);
      // Tampoco las cabeceras distinguen un caso del otro (salvo los ids y los contadores)
      const propias = (r: request.Response) =>
        Object.keys(r.headers)
          .filter(
            (c) => !/^(x-request-id|x-correlation-id|x-trace-id|date|x-ratelimit|etag)/.test(c),
          )
          .sort()
          .map((c) => `${c}: ${r.headers[c]}`);
      expect(propias(respuestas[0])).toEqual(propias(respuestas[1]));
    });

    it.each([
      ['sin pnr', { lastName: 'Pérez' }, 'pnr'],
      ['pnr de 5 caracteres', { pnr: 'ABC12', lastName: 'Pérez' }, 'pnr'],
      ['pnr con un signo', { pnr: 'ABC-12', lastName: 'Pérez' }, 'pnr'],
      ['pnr que no es texto', { pnr: 123456, lastName: 'Pérez' }, 'pnr'],
      ['sin lastName', { pnr: 'ABC123' }, 'lastName'],
      ['lastName vacío', { pnr: 'ABC123', lastName: '' }, 'lastName'],
      ['lastName de más de 100', { pnr: 'ABC123', lastName: 'a'.repeat(101) }, 'lastName'],
      [
        'un campo de más',
        { pnr: 'ABC123', lastName: 'Pérez', bookingId: randomUUID() },
        'bookingId',
      ],
    ])('400 con %s, nombrando el campo y no el valor', async (_caso, cuerpo, campo) => {
      const r = await http().post(BUSQUEDA).send(cuerpo);
      expect(r.status).toBe(400);
      esperarProblemDetails(r);
      expect(r.body.invalidParams.map((p: Cuerpo) => p.name)).toContain(campo);
      const texto = JSON.stringify(r.body);
      expect(texto).not.toContain('Pérez');
      expect(texto).not.toMatch(/ABC-?12|123456/);
    });

    it('el PNR y el apellido no viajan en la URL: GET no existe y la query se ignora', async () => {
      const r = await http().get(`${BUSQUEDA}?pnr=${reservaA.pnr}&lastName=x`);
      expect(r.status).toBe(405);
      expect(JSON.stringify(r.body)).not.toContain(reservaA.pnr);
    });

    it('la comparación del apellido: normaliza los dos lados y no acepta uno vacío', () => {
      expect(normalizarApellido(" d'Ávila-ñáñez ")).toBe('DAVILANANEZ');
      const comparador = app.get(ComparadorApellidos);
      expect(comparador.coincide('perez', ['Pérez', 'Gómez'])).toBe(true);
      expect(comparador.coincide('gomez', ['Pérez', 'Gómez'])).toBe(true);
      expect(comparador.coincide('pere', ['Pérez'])).toBe(false);
      expect(comparador.coincide('perez', [])).toBe(false);
      expect(comparador.coincide('', [''])).toBe(false);
      expect(comparador.coincide('--', ['Pérez'])).toBe(false);
      expect(comparador.coincide('sin-reserva', [])).toBe(false);
    });
  });

  describe('la sesión solo sirve para su reserva', () => {
    let deA: string;
    let deB: string;

    beforeAll(async () => {
      // 24 h antes: la ventana de check-in de las dos reservas está abierta
      reloj.fijar(new Date(salidaDe(reservaA).getTime() - 24 * HORA));
      deA = (await abrir(reservaA, APELLIDO_A)).kioskToken;
      deB = (await abrir(reservaB, 'zambrano velez')).kioskToken;
    });
    beforeEach(() => reloj.fijar(new Date(salidaDe(reservaA).getTime() - 24 * HORA)));

    it('la sesión de la reserva A sobre la reserva B: 404 en el check-in y en los pases, y no registra nada', async () => {
      for (const r of [
        await hacerCheckin(reservaB.bookingId, sesion(deA)),
        await pases(reservaB.bookingId, sesion(deA)),
        await hacerCheckin(reservaA.bookingId, sesion(deB)),
        await pases(reservaA.bookingId, sesion(deB)),
        await hacerCheckin(randomUUID(), sesion(deA)),
      ]) {
        expect(r.status).toBe(404);
        esperarProblemDetails(r);
        expect(r.body.detail).toBe('Booking not found');
      }
      expect(await registros(reservaA.bookingId)).toBe(0);
      expect(await registros(reservaB.bookingId)).toBe(0);
    });

    it('sin sesión, con otro esquema o con un token de acceso: 401 KIOSK_SESSION_INVALID', async () => {
      for (const autorizacion of [
        undefined,
        '',
        deA,
        `Bearer ${deA}`,
        `kiosk ${deA}`,
        `Bearer ${cliente.token}`,
        `Kiosk ${cliente.token}`,
        'Kiosk ',
        'Kiosk ksk1.e30.AAAA',
      ]) {
        esperarSesionInvalida(await hacerCheckin(reservaA.bookingId, autorizacion));
        esperarSesionInvalida(await pases(reservaA.bookingId, autorizacion));
      }
      expect(await registros(reservaA.bookingId)).toBe(0);
    });

    it('una sesión alterada (otra reserva en el payload, firma cambiada o recortada): 401', async () => {
      const [version, , firma] = deA.split('.');
      const vence = Math.floor(reloj.ahora().getTime() / 1000) + 600;
      const payloadDeB = Buffer.from(JSON.stringify({ r: reservaB.bookingId, e: vence })).toString(
        'base64url',
      );
      const payloadEterno = Buffer.from(
        JSON.stringify({ r: reservaA.bookingId, e: vence + 10_000_000 }),
      ).toString('base64url');
      const alteradas = [
        `${version}.${payloadDeB}.${firma}`,
        `${version}.${payloadEterno}.${firma}`,
        `${deA.slice(0, -1)}${deA.endsWith('A') ? 'B' : 'A'}`,
        deA.slice(0, -4),
        `ksk2${deA.slice(4)}`,
        `${deA}.extra`,
      ];
      for (const token of alteradas) {
        esperarSesionInvalida(await hacerCheckin(reservaB.bookingId, sesion(token)));
        esperarSesionInvalida(await hacerCheckin(reservaA.bookingId, sesion(token)));
      }
      expect(await registros(reservaA.bookingId)).toBe(0);
      expect(await registros(reservaB.bookingId)).toBe(0);
    });

    it('la sesión del kiosko no es un token de acceso: las rutas del contrato la rechazan con 401', async () => {
      for (const autorizacion of [`Bearer ${deA}`, sesion(deA)]) {
        for (const r of [
          await http().get(`${RESERVAS}/${reservaA.bookingId}`).set('Authorization', autorizacion),
          await http()
            .post(`${RESERVAS}/${reservaA.bookingId}/check-in`)
            .set('Authorization', autorizacion),
          await http().get(RESERVAS).set('Authorization', autorizacion),
        ]) {
          expect(r.status).toBe(401);
        }
      }
    });

    it('vence a los 10 minutos del Reloj: un segundo antes sirve y al cumplirse es 401', async () => {
      const token = (await abrir(reservaB, 'Zambrano Vélez')).kioskToken;
      const emitida = Math.floor(reloj.ahora().getTime() / 1000) * 1000;
      reloj.fijar(new Date(emitida + 10 * MINUTO - 1000));
      expect((await pases(reservaB.bookingId, sesion(token))).status).toBe(200);
      reloj.fijar(new Date(emitida + 10 * MINUTO));
      const vencida = await pases(reservaB.bookingId, sesion(token));
      esperarSesionInvalida(vencida);
      expect(vencida.body.detail).toMatch(/expired/);
      esperarSesionInvalida(await hacerCheckin(reservaB.bookingId, sesion(token)));
      expect(await registros(reservaB.bookingId)).toBe(0);
    });

    it('bookingId que no es uuid: 400', async () => {
      expect((await hacerCheckin('no-es-uuid', sesion(deA))).status).toBe(400);
      expect((await pases('no-es-uuid', sesion(deA))).status).toBe(400);
    });
  });

  describe('check-in y pases con la sesión: los mismos del contrato', () => {
    let token: string;
    let respuesta: request.Response;

    beforeAll(async () => {
      reloj.fijar(new Date(salidaDe(reservaA).getTime() - 24 * HORA));
      const abierta = await abrir(reservaA, 'QUISHPE TOAQUIZA');
      expect(abierta.booking.flights[0].checkIn.window).toBe('OPEN');
      token = abierta.kioskToken;
      expect((await pases(reservaA.bookingId, sesion(token)).expect(200)).body).toEqual({
        bookingId: reservaA.bookingId,
        boardingPasses: [],
      });
      respuesta = await hacerCheckin(reservaA.bookingId, sesion(token));
    });
    beforeEach(() => reloj.fijar(new Date(salidaDe(reservaA).getTime() - 24 * HORA)));

    it('200 CheckInResponse del contrato, COMPLETED, con los asientos de la reserva', () => {
      expect(respuesta.status).toBe(200);
      expect(erroresContraContrato('CheckInResponse', respuesta.body)).toEqual([]);
      expect(respuesta.body.status).toBe('COMPLETED');
      expect(respuesta.headers['cache-control']).toBe('no-store');
    });

    it('es el mismo check-in que ve el dueño con su cuenta, y repetirlo no cambia nada', async () => {
      const delDueno = await con(app, cliente.token)(
        'post',
        `${RESERVAS}/${reservaA.bookingId}/check-in`,
      ).expect(200);
      expect(delDueno.body).toEqual(respuesta.body);
      const repetido = await hacerCheckin(reservaA.bookingId, sesion(token)).expect(200);
      expect(repetido.body).toEqual(respuesta.body);
      expect(await registros(reservaA.bookingId)).toBe(3);
    });

    it('la auditoría dice que lo hizo un kiosko', async () => {
      const filas = await prisma.db.auditoria.findMany({
        where: { nombre_tabla: 'checkin', operacion: 'INSERCION' },
        orderBy: { id: 'desc' },
        take: 3,
      });
      expect(filas.map((f) => f.id_usuario)).toEqual(['kiosko', 'kiosko', 'kiosko']);
    });

    it('los pases son BoardingPassListResponse y los mismos que ve el dueño', async () => {
      const r = await pases(reservaA.bookingId, sesion(token)).expect(200);
      expect(erroresContraContrato('BoardingPassListResponse', r.body)).toEqual([]);
      expect(r.body.boardingPasses).toHaveLength(2);
      expect(r.headers['cache-control']).toBe('no-store');
      const delDueno = await con(app, cliente.token)(
        'get',
        `${RESERVAS}/${reservaA.bookingId}/boarding-passes`,
      ).expect(200);
      expect(r.body).toEqual(delDueno.body);
    });

    it('la búsqueda muestra después el check-in hecho, por vuelo y pasajero', async () => {
      const abierta = await abrir(reservaA, APELLIDO_A);
      expect(
        abierta.booking.flights[0].passengers.map((p: Cuerpo) => [p.passengerId, p.checkInStatus]),
      ).toEqual([
        ['ADU1', 'CHECKED_IN'],
        ['ADU2', 'CHECKED_IN'],
        ['INF3', 'CHECKED_IN'],
      ]);
    });

    it('fuera de la ventana responde el 409 del check-in de siempre', async () => {
      reloj.alPresente();
      const abierta = await abrir(reservaB, 'Zambrano Vélez');
      expect(abierta.booking.flights[0].checkIn.window).toBe('NOT_YET_OPEN');
      const r = await hacerCheckin(reservaB.bookingId, sesion(abierta.kioskToken));
      expect([r.status, r.body.code]).toEqual([409, 'CHECK_IN_NOT_AVAILABLE']);
      expect(await registros(reservaB.bookingId)).toBe(0);
    });
  });

  describe('límites y registro', () => {
    it('la búsqueda tiene su propio límite: la undécima en un minuto es 429 con Retry-After, acierte o no', async () => {
      reloj.alPresente();
      for (let i = 0; i < LIMITES_KIOSKO.busqueda.limite; i++) {
        expect((await buscar('ZZZZ99', 'Nadie')).status).toBe(404);
      }
      const bloqueada = await buscar(reservaA.pnr, APELLIDO_A);
      expect([bloqueada.status, bloqueada.body.code]).toEqual([429, 'RATE_LIMIT_EXCEEDED']);
      expect(Number(bloqueada.headers['retry-after'])).toBeGreaterThan(0);
      // El límite es de la búsqueda: otra ruta pública sigue respondiendo
      expect((await http().get('/flights/v1/health')).status).toBe(200);
      // Pasada la ventana (con el Reloj), vuelve a responder
      reloj.adelantar(1);
      expect((await buscar(reservaA.pnr, APELLIDO_A)).status).toBe(200);
    });

    it('las tres rutas son públicas con límite estricto', () => {
      expect(LIMITES_KIOSKO).toEqual({
        busqueda: { limite: 10, ventanaSegundos: 60 },
        checkin: { limite: 20, ventanaSegundos: 60 },
        pases: { limite: 60, ventanaSegundos: 60 },
      });
      for (const metodo of ['buscar', 'hacerCheckin', 'pases'] as const) {
        expect(Reflect.getMetadata(ES_LIMITE_ESTRICTO, KioskoController.prototype[metodo])).toBe(
          true,
        );
        expect(Reflect.getMetadata('esPublico', KioskoController.prototype[metodo])).toBe(true);
      }
    });

    it('nada de lo que pasó dejó el PNR, un apellido, un nombre ni una sesión en el log', async () => {
      // Deja una línea de cada tipo antes de mirar: un acierto, un fallo y un error de sesión
      reloj.alPresente();
      limites.reiniciar();
      const abierta = await abrir(reservaA, APELLIDO_A);
      await buscar(reservaA.pnr, 'Apellido Equivocado');
      await hacerCheckin(reservaB.bookingId, sesion(abierta.kioskToken));
      await hacerCheckin(reservaA.bookingId, 'Kiosk ksk1.e30.AAAA');

      const texto = log.texto();
      expect(log.lineas.length).toBeGreaterThan(10);
      expect(texto).toContain('/flights/v1/kiosk/lookup');
      for (const dato of [
        reservaA.pnr,
        reservaB.pnr,
        reservaA.pnr.toLowerCase(),
        'Ávila',
        'AVILA',
        'Ñáñez',
        'Quishpe',
        'quishpe',
        'Zambrano',
        'María José',
        'Apellido Equivocado',
        'ksk1.',
        abierta.kioskToken.split('.')[2],
      ]) {
        expect(texto).not.toContain(dato);
      }
    });
  });
});
