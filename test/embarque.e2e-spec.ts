import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { ES_LIMITE_ESTRICTO } from '../src/common/decorators/limite-peticiones.decorator';
import {
  EmbarqueController,
  LIMITE_ESCANEO,
} from '../src/modules/vuelos/administracion/embarque/embarque.controller';
import { CodigoPase } from '../src/modules/vuelos/operaciones/pase-abordar/codigo-pase';
import { PrismaService } from '../src/prisma/prisma.service';
import { crearUsuario, desactivarUsuariosDePrueba, iniciarSesion } from './utils/auth';
import { HUELLA } from './utils/busqueda';
import { ADMIN } from './utils/catalogo';
import { crearApp } from './utils/crear-app';
import { LimitesReiniciables } from './utils/limites';
import { esperarProblemDetails } from './utils/problem-details';
import { RelojDePrueba } from './utils/reloj';
import { con, nuevoCliente, pasajero } from './utils/reserva';
import {
  Cliente,
  Cuerpo,
  reservaConCheckin,
  reservaConfirmada,
  salidaDe,
  segmentoDe,
} from './utils/viaje';

const MINUTO = 60_000;
const ESCANEO = (salida: string) => `${ADMIN}/departures/${salida}/boarding/scan`;
const MANIFIESTO = (salida: string) => `${ADMIN}/departures/${salida}/boarding/manifest`;

describe('Embarque de una salida (/admin/departures/{id}/boarding)', () => {
  const reloj = new RelojDePrueba();
  const limites = new LimitesReiniciables();
  let app: INestApplication;
  let prisma: PrismaService;
  let codigoPase: CodigoPase;
  let cliente: Cliente;
  let agente: Cliente;

  const escanear = (salida: string, barcode: unknown, token: string | undefined = agente.token) =>
    con(app, token)('post', ESCANEO(salida)).send({ barcode });
  const manifiesto = (salida: string, token: string | undefined = agente.token) =>
    con(app, token)('get', MANIFIESTO(salida));

  /** Las horas de abordaje de los pasajeros de la reserva en esa salida, por passengerId. */
  const abordajes = async (reservaId: string, salida: string) =>
    Object.fromEntries(
      (
        await prisma.db.checkin.findMany({
          where: {
            vuelo_programado_id: salida,
            estado: 'REGISTRADO',
            reserva_detalle_pasajero: { reserva_id: reservaId },
          },
          select: {
            fecha_abordaje: true,
            reserva_detalle_pasajero: { select: { codigo_pasajero: true } },
          },
        })
      ).map((c) => [c.reserva_detalle_pasajero.codigo_pasajero, c.fecha_abordaje]),
    );

  /** Un código con firma válida para el pasajero `i` de la reserva, con lo que se le cambie. */
  const codigoPara = (reserva: Cuerpo, i = 0, cambios: Record<string, unknown> = {}) => {
    const segmento = segmentoDe(reserva);
    const pax = reserva.passengers[i];
    const boleto = reserva.tickets.find((t: Cuerpo) => t.passengerId === pax.passengerId);
    return codigoPase.generar({
      pnr: reserva.pnr,
      numeroBoleto: boleto.eTicketNumber,
      numeroVuelo: segmento.flightNumber,
      fechaSalida: new Date(`${segmento.departure.at.slice(0, 10)}T00:00:00.000Z`),
      origen: 'UIO',
      destino: 'GYE',
      asiento: pax.assignedSeats[0].seatNumber,
      secuencia: i + 1,
      ...cambios,
    });
  };

  /** Cambia el estado de la salida mientras corre `trabajo` y lo devuelve a PROGRAMADO. */
  async function conEstado(salida: string, estado: string, trabajo: () => Promise<void>) {
    await prisma.db
      .$executeRaw`UPDATE vuelos.vuelo_programado SET estado = ${estado}::vuelos.estado_vuelo WHERE id = ${salida}::uuid`;
    try {
      await trabajo();
    } finally {
      await prisma.db
        .$executeRaw`UPDATE vuelos.vuelo_programado SET estado = 'PROGRAMADO' WHERE id = ${salida}::uuid`;
    }
  }

  const esperarRechazo = (respuesta: request.Response, status: number, code: string) => {
    expect([respuesta.status, respuesta.body.code]).toEqual([status, code]);
    esperarProblemDetails(respuesta);
    expect(respuesta.body.type).toBe(
      `https://api.booking-hub.com/errors/${code.toLowerCase().replace(/_/g, '-')}`,
    );
  };

  beforeAll(async () => {
    app = await crearApp([], { reloj, limites });
    prisma = app.get(PrismaService);
    codigoPase = app.get(CodigoPase);
    cliente = await nuevoCliente(app);
    const administrador = await crearUsuario(app, { administrador: true });
    agente = {
      id: administrador.id,
      token: (await iniciarSesion(app, administrador)).access_token,
    };
  });
  beforeEach(() => limites.reiniciar());
  afterAll(async () => {
    await desactivarUsuariosDePrueba(app);
    await app.close();
  });

  describe('escaneo aceptado: dos adultos y un infante', () => {
    const adulto1 = pasajero('ADULT', 1, { firstName: 'Rosa Elena', lastName: 'Muñoz Cárdenas' });
    const adulto2 = pasajero('ADULT', 2, { firstName: 'Julián', lastName: 'Muñoz Cárdenas' });
    const infante = pasajero('INFANT', 3, {
      firstName: 'Inés',
      lastName: 'Muñoz Vera',
      associatedAdultId: adulto1.passengerId,
    });
    let reserva: Cuerpo;
    let pases: Cuerpo[];
    let salida: string;
    let hora: Date;
    let respuesta: request.Response;

    beforeAll(async () => {
      ({ reserva, pases } = await reservaConCheckin(app, reloj, cliente, 30, [
        adulto1,
        adulto2,
        infante,
      ]));
      salida = segmentoDe(reserva).segmentId;
      hora = new Date(salidaDe(reserva).getTime() - 40 * MINUTO);
      reloj.fijar(hora);
      respuesta = await escanear(salida, pases.find((p) => p.passengerId === 'ADU1')!.barcode);
    });

    it('200 con resultado, asiento, grupo y el nombre del pasajero; el infante aborda con su adulto', () => {
      expect(respuesta.status).toBe(200);
      const pase = pases.find((p) => p.passengerId === 'ADU1')!;
      expect(respuesta.body).toEqual({
        result: 'BOARDED',
        departureId: salida,
        flightNumber: segmentoDe(reserva).flightNumber,
        seat: pase.seat,
        boardingGroup: pase.boardingGroup,
        boardingPosition: pase.boardingPosition,
        boardedAt: hora.toISOString(),
        passenger: { passengerId: 'ADU1', firstName: 'Rosa Elena', lastName: 'Muñoz Cárdenas' },
        infants: [{ passengerId: 'INF3', firstName: 'Inés', lastName: 'Muñoz Vera' }],
      });
      expect(respuesta.headers['cache-control']).toBe('no-store');
    });

    it('la respuesta no lleva documento, correo ni teléfono', () => {
      const texto = JSON.stringify(respuesta.body);
      for (const p of [adulto1, infante]) {
        expect(texto).not.toContain(p.documentNumber);
        expect(texto).not.toContain(p.contact.email);
        expect(texto).not.toContain(p.contact.phone);
      }
    });

    it('guarda la hora del Reloj en el check-in del adulto y del infante, no en el del otro adulto', async () => {
      expect(await abordajes(reserva.bookingId, salida)).toEqual({
        ADU1: hora,
        ADU2: null,
        INF3: hora,
      });
    });

    it('queda en la auditoría con el agente que escaneó', async () => {
      const filas = await prisma.db.auditoria.findMany({
        where: { nombre_tabla: 'checkin', operacion: 'ACTUALIZACION', id_usuario: agente.id },
        orderBy: { id: 'desc' },
        take: 2,
      });
      expect(filas).toHaveLength(2);
      for (const fila of filas) {
        expect(fila.datos_anteriores).toEqual({ fecha_abordaje: null });
        expect(Object.keys(fila.datos_nuevos as object)).toEqual(['fecha_abordaje']);
      }
    });

    it('escanear el mismo pase otra vez: 409 ALREADY_BOARDED con la hora, y no cambia nada', async () => {
      reloj.adelantar(5);
      const repetido = await escanear(salida, pases.find((p) => p.passengerId === 'ADU1')!.barcode);
      esperarRechazo(repetido, 409, 'ALREADY_BOARDED');
      expect(repetido.body.detail).toContain(hora.toISOString());
      expect((await abordajes(reserva.bookingId, salida)).ADU1).toEqual(hora);
    });

    it('el manifiesto: conteos y una fila por asiento con su estado, sin datos personales', async () => {
      const r = await manifiesto(salida).expect(200);
      const segmento = segmentoDe(reserva);
      expect(r.body).toMatchObject({
        departureId: salida,
        flightNumber: segmento.flightNumber,
        date: segmento.departure.at.slice(0, 10),
        origin: 'UIO',
        destination: 'GYE',
        status: 'SCHEDULED',
        gate: null,
      });
      expect(r.headers['cache-control']).toBe('no-store');
      const mios = r.body.seats.filter((a: Cuerpo) => a.pnr === reserva.pnr);
      const porPasajero = Object.fromEntries(mios.map((a: Cuerpo) => [a.passengerId, a]));
      expect(porPasajero).toEqual({
        ADU1: {
          seat: reserva.passengers[0].assignedSeats[0].seatNumber,
          cabinClass: 'ECONOMY',
          pnr: reserva.pnr,
          passengerId: 'ADU1',
          status: 'BOARDED',
          boardingGroup: '3',
          boardedAt: hora.toISOString(),
        },
        ADU2: {
          seat: reserva.passengers[1].assignedSeats[0].seatNumber,
          cabinClass: 'ECONOMY',
          pnr: reserva.pnr,
          passengerId: 'ADU2',
          status: 'CHECKED_IN',
          boardingGroup: '3',
          boardedAt: null,
        },
      });
      // Los conteos salen de la misma lista: otras pruebas también venden asientos de esta salida
      const con_ = (estados: string[]) =>
        r.body.seats.filter((a: Cuerpo) => estados.includes(a.status)).length;
      expect(r.body.counts.sold).toBe(r.body.seats.length);
      expect(r.body.counts.checkedIn).toBe(con_(['CHECKED_IN', 'BOARDED']));
      expect(r.body.counts.boarded).toBe(con_(['BOARDED']));
      expect(r.body.counts.boarded).toBeGreaterThanOrEqual(1);
      expect(r.body.counts.checkedIn).toBeGreaterThanOrEqual(2);
      expect(r.body.counts.infants.sold).toBeGreaterThanOrEqual(1);
      expect(r.body.counts.infants.checkedIn).toBeGreaterThanOrEqual(1);
      expect(r.body.counts.infants.boarded).toBeGreaterThanOrEqual(1);
      // Los asientos van en orden de fila y letra
      const orden = r.body.seats.map((a: Cuerpo) => a.seat);
      expect(orden).toEqual(
        [...orden].sort((a: string, b: string) => parseInt(a) - parseInt(b) || a.localeCompare(b)),
      );

      const texto = JSON.stringify(r.body);
      expect(Object.keys(mios[0]).sort()).toEqual([
        'boardedAt',
        'boardingGroup',
        'cabinClass',
        'passengerId',
        'pnr',
        'seat',
        'status',
      ]);
      for (const p of [adulto1, adulto2, infante]) {
        expect(texto).not.toContain(p.firstName);
        expect(texto).not.toContain(p.lastName);
        expect(texto).not.toContain(p.documentNumber);
        expect(texto).not.toContain(p.contact.email);
      }
    });

    it('el mapa de asientos v2 da BOARDED al asiento abordado y CHECKED_IN al otro', async () => {
      const segmento = segmentoDe(reserva);
      const busqueda = await request(app.getHttpServer())
        .post('/flights/v1/search')
        .set('X-Device-Fingerprint', HUELLA)
        .send({
          itineraries: [
            {
              origin: 'UIO',
              destination: 'GYE',
              departureDate: segmento.departure.at.slice(0, 10),
            },
          ],
          passengers: { adults: 1 },
        })
        .expect(200);
      const oferta = busqueda.body.offers.find((o: Cuerpo) =>
        o.itineraries[0].segments.some((s: Cuerpo) => s.segmentId === salida),
      );
      const mapa = await request(app.getHttpServer())
        .get(`/api/v2/vuelos/offers/${oferta.offerId}/seatmap?segmentId=${salida}`)
        .expect(200);
      const estados = Object.fromEntries(
        (mapa.body.cabins as Cuerpo[])
          .flatMap((c) => (c.rows as Cuerpo[]).flatMap((f) => f.seats as Cuerpo[]))
          .map((a) => [a.seatNumber, a.status]),
      );
      expect(estados[reserva.passengers[0].assignedSeats[0].seatNumber]).toBe('BOARDED');
      expect(estados[reserva.passengers[1].assignedSeats[0].seatNumber]).toBe('CHECKED_IN');
    });

    it('la puerta que pone el administrador sale en el manifiesto', async () => {
      await con(app, agente.token)('patch', `${ADMIN}/departures/${salida}`)
        .send({ departureGate: 'A3' })
        .expect(200);
      try {
        expect((await manifiesto(salida).expect(200)).body.gate).toBe('A3');
      } finally {
        const quitada = await con(app, agente.token)('patch', `${ADMIN}/departures/${salida}`)
          .send({ departureGate: null })
          .expect(200);
        expect(quitada.body.departureGate).toBeNull();
      }
      const invalida = await con(app, agente.token)('patch', `${ADMIN}/departures/${salida}`).send({
        departureGate: 'puerta muy larga',
      });
      expect(invalida.status).toBe(400);
    });
  });

  describe('carreras', () => {
    it('dos escaneos simultáneos del mismo pase: uno 200 y el otro 409 ALREADY_BOARDED', async () => {
      const { reserva, pases } = await reservaConCheckin(app, reloj, cliente, 31, [
        pasajero('ADULT', 1),
        pasajero('ADULT', 2),
      ]);
      const salida = segmentoDe(reserva).segmentId;
      reloj.fijar(new Date(salidaDe(reserva).getTime() - 30 * MINUTO));
      for (const pase of pases) {
        const respuestas = await Promise.all([
          escanear(salida, pase.barcode),
          escanear(salida, pase.barcode),
        ]);
        expect(respuestas.map((r) => r.status).sort()).toEqual([200, 409]);
        esperarRechazo(
          respuestas.find((r) => r.status === 409)!,
          409,
          'ALREADY_BOARDED',
        );
      }
      const horas = await abordajes(reserva.bookingId, salida);
      expect(Object.values(horas).every((h) => h !== null)).toBe(true);
    });

    it('seis escaneos a la vez: exactamente uno gana y la auditoría tiene un solo cambio', async () => {
      const { reserva, pases } = await reservaConCheckin(app, reloj, cliente, 32);
      const salida = segmentoDe(reserva).segmentId;
      reloj.fijar(new Date(salidaDe(reserva).getTime() - 30 * MINUTO));
      const respuestas = await Promise.all(
        Array.from({ length: 6 }, () => escanear(salida, pases[0].barcode)),
      );
      expect(respuestas.filter((r) => r.status === 200)).toHaveLength(1);
      const perdedores = respuestas.filter((r) => r.status !== 200);
      expect(perdedores).toHaveLength(5);
      for (const r of perdedores) esperarRechazo(r, 409, 'ALREADY_BOARDED');

      const [registro] = await prisma.db.checkin.findMany({
        where: {
          vuelo_programado_id: salida,
          reserva_detalle_pasajero: { reserva_id: reserva.bookingId },
        },
      });
      const cambios = await prisma.db.auditoria.count({
        where: {
          nombre_tabla: 'checkin',
          operacion: 'ACTUALIZACION',
          id_registro: String(registro.id),
        },
      });
      expect(cambios).toBe(1);
    });
  });

  describe('cada validación tiene su code', () => {
    let reserva: Cuerpo;
    let pases: Cuerpo[];
    let salida: string;
    let sinCheckin: Cuerpo;

    beforeAll(async () => {
      reloj.alPresente();
      sinCheckin = await reservaConfirmada(app, cliente, 33);
      ({ reserva, pases } = await reservaConCheckin(app, reloj, cliente, 33));
      salida = segmentoDe(reserva).segmentId;
      reloj.fijar(new Date(salidaDe(reserva).getTime() - 30 * MINUTO));
    });
    afterEach(async () => {
      // Ningún rechazo embarca a nadie
      expect(await abordajes(reserva.bookingId, salida)).toEqual({ ADU1: null });
    });

    it.each([
      ['un texto cualquiera', 'hola'],
      [
        'otra versión del formato',
        'BP2|K7M2QX|0451331201527|LA1400|20261020|UIOGYE|10A|001|9f2c41b7a0d3',
      ],
      ['un campo de menos', 'BP1|K7M2QX|0451331201527|LA1400|20261020|UIOGYE|10A|9f2c41b7a0d3'],
      [
        'una firma que no es hexadecimal',
        'BP1|K7M2QX|0451331201527|LA1400|20261020|UIOGYE|10A|001|ZZZZZZZZZZZZ',
      ],
    ])('formato, %s: 400 BOARDING_PASS_MALFORMED', async (_caso, texto) => {
      const r = await escanear(salida, texto);
      esperarRechazo(r, 400, 'BOARDING_PASS_MALFORMED');
      expect(r.body.invalidParams).toEqual([{ name: 'barcode', reason: expect.any(String) }]);
    });

    it.each([
      ['sin barcode', undefined],
      ['un número', 12345],
      ['vacío', ''],
      ['de más de 120 caracteres', 'B'.repeat(121)],
    ])('cuerpo inválido, %s: 400 VALIDATION_FAILED', async (_caso, barcode) => {
      esperarRechazo(await escanear(salida, barcode), 400, 'VALIDATION_FAILED');
    });

    it('firma: un código alterado (otro asiento, otro boleto u otra firma) es 422 BOARDING_PASS_SIGNATURE_INVALID', async () => {
      const original: string = pases[0].barcode;
      const partes = original.split('|');
      const alterados = [
        // Otro asiento con la firma del original
        [...partes.slice(0, 6), partes[6] === '1A' ? '2A' : '1A', ...partes.slice(7)].join('|'),
        // Otro boleto
        [...partes.slice(0, 2), '9999999999999', ...partes.slice(3)].join('|'),
        // La firma cambiada en un carácter
        `${original.slice(0, -1)}${original.endsWith('0') ? '1' : '0'}`,
      ];
      for (const codigo of alterados) {
        esperarRechazo(await escanear(salida, codigo), 422, 'BOARDING_PASS_SIGNATURE_INVALID');
      }
    });

    it('la salida no existe: 404; un id que no es uuid: 400', async () => {
      const inexistente = await escanear(randomUUID(), pases[0].barcode);
      esperarRechazo(inexistente, 404, 'VALIDATION_FAILED');
      esperarRechazo(await escanear('no-es-uuid', pases[0].barcode), 400, 'VALIDATION_FAILED');
    });

    it('la salida está cancelada: 409 FLIGHT_CANCELLED', async () => {
      await conEstado(salida, 'CANCELADO', async () => {
        esperarRechazo(await escanear(salida, pases[0].barcode), 409, 'FLIGHT_CANCELLED');
      });
    });

    it.each(['DESPEGADO', 'ATERRIZADO', 'DESVIADO'])(
      'la salida ya está %s: 409 FLIGHT_ALREADY_DEPARTED',
      async (estado) => {
        await conEstado(salida, estado, async () => {
          esperarRechazo(await escanear(salida, pases[0].barcode), 409, 'FLIGHT_ALREADY_DEPARTED');
        });
      },
    );

    it('con la salida EMBARCANDO o DEMORADA el escaneo no se rechaza por el estado', async () => {
      const deSinCheckin = segmentoDe(sinCheckin).segmentId;
      for (const estado of ['EMBARCANDO', 'DEMORADO']) {
        await conEstado(deSinCheckin, estado, async () => {
          // Un pase sin check-in llega hasta esa validación: el estado de la salida no lo frenó
          esperarRechazo(
            await escanear(deSinCheckin, codigoPara(sinCheckin)),
            409,
            'PASSENGER_NOT_CHECKED_IN',
          );
        });
      }
    });

    it('el pase es de otra salida: 409 BOARDING_PASS_WRONG_FLIGHT, sin abordar en ninguna', async () => {
      const [otra] = await prisma.db.$queryRaw<Array<{ id: string }>>`
        SELECT vp.id FROM vuelos.vuelo_programado vp
         WHERE vp.id <> ${salida}::uuid AND vp.estado = 'PROGRAMADO'
           AND vp.salida_programada > now() + interval '40 days'
         LIMIT 1`;
      const r = await escanear(otra.id, pases[0].barcode);
      esperarRechazo(r, 409, 'BOARDING_PASS_WRONG_FLIGHT');
      // El mismo vuelo en otra fecha también es otra salida
      const [otroDia] = await prisma.db.$queryRaw<Array<{ id: string }>>`
        SELECT o.id FROM vuelos.vuelo_programado vp
          JOIN vuelos.vuelo_programado o ON o.vuelo_id = vp.vuelo_id AND o.id <> vp.id
         WHERE vp.id = ${salida}::uuid AND o.estado = 'PROGRAMADO'
         LIMIT 1`;
      esperarRechazo(
        await escanear(otroDia.id, pases[0].barcode),
        409,
        'BOARDING_PASS_WRONG_FLIGHT',
      );
    });

    it('el boleto no existe o no es de ese PNR: 404 BOARDING_PASS_NOT_FOUND', async () => {
      esperarRechazo(
        await escanear(salida, codigoPara(reserva, 0, { numeroBoleto: '9999999999999' })),
        404,
        'BOARDING_PASS_NOT_FOUND',
      );
      esperarRechazo(
        await escanear(salida, codigoPara(reserva, 0, { pnr: 'ZZZZZ9' })),
        404,
        'BOARDING_PASS_NOT_FOUND',
      );
    });

    it('la reserva ya no está confirmada: 409 BOARDING_PASS_NOT_VALID', async () => {
      await prisma.db
        .$executeRaw`UPDATE vuelos.reserva_cabecera SET estado = 'CANCELACION_PENDIENTE' WHERE id = ${reserva.bookingId}::uuid`;
      try {
        esperarRechazo(await escanear(salida, pases[0].barcode), 409, 'BOARDING_PASS_NOT_VALID');
      } finally {
        await prisma.db
          .$executeRaw`UPDATE vuelos.reserva_cabecera SET estado = 'CONFIRMADA' WHERE id = ${reserva.bookingId}::uuid`;
      }
    });

    it('un código firmado que no es el pase emitido (otro asiento): 409 BOARDING_PASS_NOT_VALID', async () => {
      const asiento = pases[0].seat === '30F' ? '29F' : '30F';
      esperarRechazo(
        await escanear(salida, codigoPara(reserva, 0, { asiento })),
        409,
        'BOARDING_PASS_NOT_VALID',
      );
    });

    it('el pasajero no tiene check-in en esa salida: 409 PASSENGER_NOT_CHECKED_IN', async () => {
      const r = await escanear(segmentoDe(sinCheckin).segmentId, codigoPara(sinCheckin));
      esperarRechazo(r, 409, 'PASSENGER_NOT_CHECKED_IN');
    });

    it('ningún rechazo lleva el nombre, el documento, el PNR ni el código escaneado', async () => {
      const original: string = pases[0].barcode;
      const respuestas = [
        await escanear(salida, 'hola'),
        await escanear(salida, `${original.slice(0, -1)}${original.endsWith('0') ? '1' : '0'}`),
        await escanear(salida, codigoPara(reserva, 0, { asiento: '30F' })),
        await escanear(segmentoDe(sinCheckin).segmentId, codigoPara(sinCheckin)),
        await escanear(randomUUID(), original),
      ];
      const pax = reserva.passengers[0];
      for (const r of respuestas) {
        const texto = JSON.stringify(r.body);
        expect(r.status).toBeGreaterThanOrEqual(400);
        for (const dato of [
          pax.firstName,
          pax.lastName,
          pax.documentNumber,
          reserva.pnr,
          sinCheckin.pnr,
          original,
        ]) {
          expect(texto).not.toContain(dato);
        }
      }
    });

    it('después de todos los rechazos, el pase válido sigue embarcando', async () => {
      const r = await escanear(salida, pases[0].barcode);
      expect(r.status).toBe(200);
      expect(r.body.infants).toEqual([]);
      await prisma.db
        .$executeRaw`UPDATE vuelos.checkin SET fecha_abordaje = NULL WHERE vuelo_programado_id = ${salida}::uuid AND pasajero_id IN (SELECT id FROM vuelos.reserva_detalle_pasajero WHERE reserva_id = ${reserva.bookingId}::uuid)`;
    });
  });

  describe('seguridad y límites', () => {
    it('sin token 401 y con un token de cliente 403, en el escaneo y en el manifiesto', async () => {
      const salida = randomUUID();
      for (const [token, status] of [
        [undefined, 401],
        [cliente.token, 403],
      ] as const) {
        const escaneo = await con(app, token)('post', ESCANEO(salida)).send({ barcode: 'x' });
        expect(escaneo.status).toBe(status);
        esperarProblemDetails(escaneo);
        const lista = await con(app, token)('get', MANIFIESTO(salida));
        expect(lista.status).toBe(status);
      }
    });

    it('el manifiesto de una salida que no existe: 404; id que no es uuid: 400', async () => {
      expect((await manifiesto(randomUUID())).status).toBe(404);
      expect((await manifiesto('x')).status).toBe(400);
    });

    it('el escaneo tiene su propio límite de 120 por minuto, aparte del global', () => {
      expect(LIMITE_ESCANEO).toEqual({ limite: 120, ventanaSegundos: 60 });
      expect(Reflect.getMetadata(ES_LIMITE_ESTRICTO, EmbarqueController.prototype.escanear)).toBe(
        true,
      );
    });
  });
});
