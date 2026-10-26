import { status as EstadoGrpc } from '@grpc/grpc-js';
import { ExecutionContext, INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import * as request from 'supertest';
import { ContextoPeticion, obtenerContexto } from '../src/common/contexto/contexto-peticion';
import { Publico } from '../src/common/decorators/publico.decorator';
import { codigoGrpc } from '../src/common/errores/codigo-grpc';
import { ErrorNegocio } from '../src/common/errores/error-negocio';
import { GuardSoloPublicoGrpc } from '../src/common/guards/solo-publico-grpc.guard';
import { validarEntorno } from '../src/config/entorno';
import { configuracionGrpc, iniciarGrpc, LIMITE_MENSAJE_GRPC } from '../src/config/grpc';
import { EstadoVuelo } from '../src/modules/vuelos/operaciones/estado-vuelo/estado-vuelo.modelo';
import { EstadoVueloService } from '../src/modules/vuelos/operaciones/estado-vuelo/estado-vuelo.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { fechaEn, HUELLA } from './utils/busqueda';
import { erroresContraContrato } from './utils/contrato';
import { crearApp } from './utils/crear-app';
import {
  aceptaConexiones,
  ClienteGrpc,
  problemaDe,
  puertoLibre,
  ResultadoGrpc,
  valorDe,
} from './utils/grpc';

/**
 * El servidor gRPC interno (docs/GRPC.md) contra la base con la semilla, con un cliente real de
 * @grpc/grpc-js: cada RPC da lo mismo que su operación REST con la misma entrada, los errores
 * salen con el código gRPC y el ProblemDetails de REST, y el x-request-id llega al contexto.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Secuencias de color ANSI de los logs de Nest (ESC = código 27). */
const COLORES_ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** Lo que las pruebas leen de una respuesta de SearchFlights. */
interface BusquedaGrpc {
  offers: Array<{
    offerId: string;
    grandTotal: { total: string };
    itineraries: Array<{
      segments: Array<{ segmentId: string; layoverMinutes?: number; departure: { at: string } }>;
    }>;
  }>;
}

/** Los enums del contrato y su prefijo en el proto. */
const PREFIJOS: Record<string, string> = {
  status: 'FLIGHT_STATUS',
  cabinClass: 'CABIN_CLASS',
  passengerType: 'PASSENGER_TYPE',
  characteristics: 'SEAT_CHARACTERISTIC',
};

/** El JSON de REST con la forma del mensaje gRPC: sin los null y con los enums del proto. */
function comoMensaje(valor: unknown, clave = ''): unknown {
  if (Array.isArray(valor)) return valor.map((v) => comoMensaje(v, clave));
  if (valor !== null && typeof valor === 'object') {
    return Object.fromEntries(
      Object.entries(valor)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => [k, comoMensaje(v, k)]),
    );
  }
  return typeof valor === 'string' && PREFIJOS[clave] ? `${PREFIJOS[clave]}_${valor}` : valor;
}

/** Cada búsqueda genera ids nuevos de oferta e itinerario; lo demás es determinista. */
function sinIdsNuevos(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(sinIdsNuevos);
  if (valor !== null && typeof valor === 'object') {
    return Object.fromEntries(
      Object.entries(valor).map(([k, v]) => [
        k,
        k === 'offerId' || k === 'itineraryId' ? '(id)' : sinIdsNuevos(v),
      ]),
    );
  }
  return valor;
}

/** El mismo error que REST: código gRPC, code y status en la metadata y el mismo ProblemDetails. */
function esperarMismoError(
  resultado: ResultadoGrpc,
  rest: request.Response,
  codigo: EstadoGrpc,
): void {
  expect(resultado.respuesta).toBeUndefined();
  expect(resultado.error?.code).toBe(codigo);
  expect(problemaDe(resultado.error)).toEqual(rest.body);
  expect(valorDe(resultado.error?.metadata, 'problem-code')).toBe(rest.body.code);
  expect(valorDe(resultado.error?.metadata, 'problem-status')).toBe(String(rest.status));
  expect(resultado.error?.details).toBe(rest.body.detail ?? rest.body.title);
}

describe('gRPC: las tres lecturas públicas', () => {
  let app: INestApplication;
  let cliente: ClienteGrpc;
  const http = () => request(app.getHttpServer());
  const buscarRest = (cuerpo: object, huella: string | null = HUELLA) => {
    const peticion = http().post('/flights/v1/search');
    return huella === null
      ? peticion.send(cuerpo)
      : peticion.set('X-Device-Fingerprint', huella).send(cuerpo);
  };

  beforeAll(async () => {
    const puerto = await puertoLibre();
    app = await crearApp([], { grpc: puerto });
    cliente = new ClienteGrpc(puerto);
  });

  afterAll(async () => {
    cliente.cerrar();
    await app.close();
  });

  describe('paridad con REST: misma entrada, mismo resultado', () => {
    it('SearchFlights: UIO-GYE solo ida con adultos, niño e infante', async () => {
      const solicitud = {
        itineraries: [{ origin: 'UIO', destination: 'GYE', departureDate: fechaEn(10) }],
        passengers: { adults: 2, children: 1, infants: 1 },
      };
      const rest = await buscarRest(solicitud).expect(200);
      expect(erroresContraContrato('SearchResponse', rest.body)).toEqual([]);
      expect(rest.body.totalOffers).toBeGreaterThan(0);

      const grpc = await cliente.llamar('SearchFlights', solicitud, {
        'x-device-fingerprint': HUELLA,
      });

      expect(grpc.error).toBeUndefined();
      expect(sinIdsNuevos(grpc.respuesta)).toEqual(sinIdsNuevos(comoMensaje(rest.body)));
    });

    it('SearchFlights: ida y vuelta UIO-GPS con escala, y las ofertas quedan guardadas como en REST', async () => {
      const solicitud = {
        itineraries: [
          { origin: 'UIO', destination: 'GPS', departureDate: fechaEn(10) },
          { origin: 'GPS', destination: 'UIO', departureDate: fechaEn(14) },
        ],
        passengers: { adults: 1, youths: 1 },
      };
      const rest = await buscarRest(solicitud).expect(200);
      expect(erroresContraContrato('SearchResponse', rest.body)).toEqual([]);

      const grpc = await cliente.llamar<BusquedaGrpc>('SearchFlights', solicitud, {
        'x-device-fingerprint': HUELLA,
      });

      expect(sinIdsNuevos(grpc.respuesta)).toEqual(sinIdsNuevos(comoMensaje(rest.body)));
      // Con escala: el segundo segmento trae la espera; el primero no la trae
      const itinerarios = grpc.respuesta!.offers.flatMap((o) => o.itineraries);
      expect(itinerarios.some((i) => i.segments.length === 2)).toBe(true);
      for (const { segments } of itinerarios) {
        expect(segments[0]).not.toHaveProperty('layoverMinutes');
        for (const segmento of segments.slice(1)) {
          expect(segmento.layoverMinutes).toBeGreaterThan(0);
        }
      }

      // La oferta de gRPC es una oferta como cualquier otra: REST abre su mapa de asientos
      const oferta = grpc.respuesta!.offers[0];
      await http()
        .get(`/flights/v1/offers/${oferta.offerId}/seatmap`)
        .query({ segmentId: oferta.itineraries[0].segments[0].segmentId })
        .expect(200);
    });

    it('GetSeatMap y GetFlightStatus de un segmento de la búsqueda', async () => {
      const fecha = fechaEn(10);
      const busqueda = await buscarRest({
        itineraries: [{ origin: 'UIO', destination: 'GYE', departureDate: fecha }],
        passengers: {},
      }).expect(200);
      const oferta = busqueda.body.offers[0];
      const segmento = oferta.itineraries[0].segments[0];

      const mapaRest = await http()
        .get(`/flights/v1/offers/${oferta.offerId}/seatmap`)
        .query({ segmentId: segmento.segmentId })
        .expect(200);
      expect(erroresContraContrato('SeatMapResponse', mapaRest.body)).toEqual([]);
      const mapa = await cliente.llamar('GetSeatMap', {
        offerId: oferta.offerId,
        segmentId: segmento.segmentId,
      });
      expect(mapa.error).toBeUndefined();
      expect(mapa.respuesta).toEqual(comoMensaje(mapaRest.body));

      const estadoRest = await http()
        .get(`/flights/v1/flights/${segmento.flightNumber}/status`)
        .query({ date: fecha })
        .expect(200);
      expect(erroresContraContrato('FlightStatus', estadoRest.body)).toEqual([]);
      const estado = await cliente.llamar('GetFlightStatus', {
        flightNumber: segmento.flightNumber,
        date: fecha,
      });
      expect(estado.error).toBeUndefined();
      expect(estado.respuesta).toEqual(comoMensaje(estadoRest.body));
      // Lo que REST da en null no viene (no llega como '' ni como null)
      expect(JSON.stringify(estado.respuesta)).not.toMatch(/null|""/);
    });

    it('dinero como texto y fechas en UTC, igual que en REST', async () => {
      const grpc = await cliente.llamar<BusquedaGrpc>(
        'SearchFlights',
        {
          itineraries: [{ origin: 'UIO', destination: 'GYE', departureDate: fechaEn(11) }],
          passengers: {},
        },
        { 'x-device-fingerprint': HUELLA },
      );
      const oferta = grpc.respuesta!.offers[0];
      expect(oferta.grandTotal.total).toMatch(/^\d+\.\d{2}$/);
      expect(oferta.itineraries[0].segments[0].departure.at).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    });
  });

  describe('errores: el código gRPC y el ProblemDetails de REST', () => {
    const SEGMENTO = '7f3c2a1e-0d4b-4c5e-9f6a-1b2c3d4e5f60';

    it('GetFlightStatus de un vuelo que no existe: NOT_FOUND como el 404', async () => {
      const fecha = fechaEn(5);
      const rest = await http().get(`/flights/v1/flights/ZZ9999/status?date=${fecha}`).expect(404);
      const grpc = await cliente.llamar('GetFlightStatus', { flightNumber: 'ZZ9999', date: fecha });
      esperarMismoError(grpc, rest, EstadoGrpc.NOT_FOUND);
    });

    it.each([
      ['una fecha que no existe', 'AV1500', '2026-02-30'],
      ['un número de vuelo inválido', 'av15', '2026-10-20'],
    ])('GetFlightStatus con %s: INVALID_ARGUMENT como el 400', async (_caso, vuelo, fecha) => {
      const rest = await http()
        .get(`/flights/v1/flights/${vuelo}/status?date=${fecha}`)
        .expect(400);
      const grpc = await cliente.llamar('GetFlightStatus', { flightNumber: vuelo, date: fecha });
      esperarMismoError(grpc, rest, EstadoGrpc.INVALID_ARGUMENT);
    });

    it('un mensaje vacío es INVALID_ARGUMENT y nombra un campo que falta', async () => {
      const grpc = await cliente.llamar('GetFlightStatus', {});
      expect(grpc.error?.code).toBe(EstadoGrpc.INVALID_ARGUMENT);
      // Nest corre los pipes de los dos campos a la vez: el error es del primero que falla
      const [parametro] = problemaDe(grpc.error).invalidParams as Array<{ name: string }>;
      expect(['flightNumber', 'date']).toContain(parametro.name);
    });

    it('GetSeatMap con un offerId que no es uuid: INVALID_ARGUMENT como el 400', async () => {
      const rest = await http()
        .get(`/flights/v1/offers/no-es-uuid/seatmap?segmentId=${SEGMENTO}`)
        .expect(400);
      const grpc = await cliente.llamar('GetSeatMap', {
        offerId: 'no-es-uuid',
        segmentId: SEGMENTO,
      });
      esperarMismoError(grpc, rest, EstadoGrpc.INVALID_ARGUMENT);
    });

    it('GetSeatMap de una oferta que no existe o venció: NOT_FOUND como el 404', async () => {
      const oferta = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
      const rest = await http()
        .get(`/flights/v1/offers/${oferta}/seatmap?segmentId=${SEGMENTO}`)
        .expect(404);
      const grpc = await cliente.llamar('GetSeatMap', { offerId: oferta, segmentId: SEGMENTO });
      esperarMismoError(grpc, rest, EstadoGrpc.NOT_FOUND);
    });

    it.each([
      [
        'campos inválidos (con invalidParams)',
        {
          itineraries: [{ origin: 'uio', destination: 'GYE', departureDate: '2026-13-01' }],
          passengers: { adults: 0 },
        },
      ],
      [
        'una fecha pasada',
        {
          itineraries: [{ origin: 'UIO', destination: 'GYE', departureDate: '2020-01-01' }],
          passengers: {},
        },
      ],
      [
        'más infantes que adultos',
        {
          itineraries: [{ origin: 'UIO', destination: 'GYE', departureDate: fechaEn(10) }],
          passengers: { adults: 1, infants: 2 },
        },
      ],
    ])('SearchFlights con %s: INVALID_ARGUMENT como el 400', async (_caso, solicitud) => {
      const rest = await buscarRest(solicitud).expect(400);
      const grpc = await cliente.llamar('SearchFlights', solicitud, {
        'x-device-fingerprint': HUELLA,
      });
      esperarMismoError(grpc, rest, EstadoGrpc.INVALID_ARGUMENT);
    });

    it('SearchFlights sin x-device-fingerprint o con dos: el mismo 400 de la cabecera', async () => {
      const solicitud = {
        itineraries: [{ origin: 'UIO', destination: 'GYE', departureDate: fechaEn(10) }],
        passengers: {},
      };
      const rest = await buscarRest(solicitud, null).expect(400);

      esperarMismoError(
        await cliente.llamar('SearchFlights', solicitud),
        rest,
        EstadoGrpc.INVALID_ARGUMENT,
      );
      const repetida = await cliente.llamar('SearchFlights', solicitud, {
        'x-device-fingerprint': [HUELLA, HUELLA],
      });
      expect(repetida.error?.code).toBe(EstadoGrpc.INVALID_ARGUMENT);
      expect(repetida.error?.details).toBe(
        'X-Device-Fingerprint: must be 8 to 128 characters: letters, digits or . _ : + / = -',
      );
      // El valor de la huella no vuelve en el error
      expect(JSON.stringify(problemaDe(repetida.error))).not.toContain(HUELLA);
    });

    it('un mensaje de más de 100 kB: RESOURCE_EXHAUSTED antes de llegar a la API', async () => {
      const grpc = await cliente.llamar(
        'SearchFlights',
        {
          itineraries: [
            { origin: 'UIO', destination: 'GYE', departureDate: 'x'.repeat(LIMITE_MENSAJE_GRPC) },
          ],
          passengers: {},
        },
        { 'x-device-fingerprint': HUELLA },
      );
      expect(grpc.error?.code).toBe(EstadoGrpc.RESOURCE_EXHAUSTED);
    });

    it.each([
      [400, EstadoGrpc.INVALID_ARGUMENT],
      [401, EstadoGrpc.UNAUTHENTICATED],
      [403, EstadoGrpc.PERMISSION_DENIED],
      [404, EstadoGrpc.NOT_FOUND],
      [409, EstadoGrpc.FAILED_PRECONDITION],
      [410, EstadoGrpc.FAILED_PRECONDITION],
      [422, EstadoGrpc.FAILED_PRECONDITION],
      [413, EstadoGrpc.RESOURCE_EXHAUSTED],
      [429, EstadoGrpc.RESOURCE_EXHAUSTED],
      [500, EstadoGrpc.INTERNAL],
      [503, EstadoGrpc.UNAVAILABLE],
      [418, EstadoGrpc.INVALID_ARGUMENT],
      [502, EstadoGrpc.INTERNAL],
    ])('tabla de códigos: %i → %s', (estado, codigo) => {
      expect(codigoGrpc(estado)).toBe(codigo);
    });
  });

  describe('x-request-id', () => {
    const consulta = () => ({ flightNumber: 'ZZ9999', date: fechaEn(5) });

    it('el que manda el cliente vuelve en la metadata, también en la de un error', async () => {
      const exito = await cliente.llamar(
        'SearchFlights',
        {
          itineraries: [{ origin: 'UIO', destination: 'GYE', departureDate: fechaEn(12) }],
          passengers: {},
        },
        { 'x-request-id': 'bff-traza-0001', 'x-device-fingerprint': HUELLA },
      );
      expect(exito.error).toBeUndefined();
      expect(valorDe(exito.inicial, 'x-request-id')).toBe('bff-traza-0001');

      const error = await cliente.llamar('GetFlightStatus', consulta(), {
        'x-request-id': 'bff-traza-0002',
      });
      expect(error.error?.code).toBe(EstadoGrpc.NOT_FOUND);
      expect(valorDe(error.error?.metadata, 'x-request-id')).toBe('bff-traza-0002');
    });

    it('sin x-request-id, o con uno inválido o repetido, la API genera uno distinto cada vez', async () => {
      const ids = [];
      for (const cabeceras of [
        {},
        {},
        { 'x-request-id': 'no vale con espacios' },
        { 'x-request-id': ['bff-traza-0003', 'bff-traza-0004'] },
      ]) {
        const resultado = await cliente.llamar('GetFlightStatus', consulta(), cabeceras);
        ids.push(valorDe(resultado.error?.metadata, 'x-request-id'));
      }
      for (const id of ids) expect(id).toMatch(UUID);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
});

describe('gRPC: contexto, log y errores internos', () => {
  let app: INestApplication;
  let cliente: ClienteGrpc;
  let escrito: string[];
  let espias: jest.SpyInstance[];
  const vistos: ContextoPeticion[] = [];
  // Una base que no responde: Prisma da el error real de conexión
  const caida = new PrismaService({
    getOrThrow: () => 'postgresql://postgres:postgres@127.0.0.1:5999/booking_db?schema=vuelos',
  } as unknown as ConfigService);

  /** EstadoVueloService de prueba: anota el contexto que ve y falla según el número de vuelo. */
  const servicio = {
    async consultar(numeroVuelo: string, fecha: Date): Promise<EstadoVuelo> {
      // Una espera de por medio: el contexto tiene que seguir siendo el de esta llamada
      await new Promise((resolver) => setTimeout(resolver, 5));
      vistos.push({ ...obtenerContexto()! });
      if (numeroVuelo === 'ZZ2') {
        throw new Error(
          'Fallo interno en /home/acer/quinde/src/x.ts:42 con vuelos.reserva_cabecera',
        );
      }
      if (numeroVuelo === 'ZZ3') await caida.db.pais.findFirst();
      const extremo = {
        iata: 'UIO',
        terminal: null,
        programada: fecha,
        estimada: null,
        real: null,
      };
      return {
        numeroVuelo,
        fecha,
        comercializa: 'ZZ',
        opera: 'ZZ',
        aeronave: '320',
        estado: 'PROGRAMADO',
        salida: extremo,
        llegada: { ...extremo, iata: 'GYE' },
      };
    },
  };

  beforeAll(async () => {
    const puerto = await puertoLibre();
    app = await crearApp([], {
      grpc: puerto,
      logs: true,
      reemplazos: [{ proveedor: EstadoVueloService, valor: servicio }],
    });
    cliente = new ClienteGrpc(puerto);
  });

  // Nest escribe los logs normales en stdout y los de error en stderr
  beforeEach(() => {
    escrito = [];
    espias = [process.stdout, process.stderr].map((salida) =>
      jest.spyOn(salida, 'write').mockImplementation((texto: string | Uint8Array) => {
        escrito.push(String(texto));
        return true;
      }),
    );
  });

  afterEach(() => {
    espias.forEach((espia) => espia.mockRestore());
  });

  afterAll(async () => {
    cliente.cerrar();
    await app.close();
    await caida.onModuleDestroy();
  });

  const lineas = () => escrito.join('').replace(COLORES_ANSI, '').split('\n');
  const estado = (vuelo: string, id: string) =>
    cliente.llamar(
      'GetFlightStatus',
      { flightNumber: vuelo, date: '2026-10-20' },
      { 'x-request-id': id },
    );

  it('el x-request-id llega al mismo AsyncLocalStorage que usa HTTP, con la IP del cliente', async () => {
    const resultados = await Promise.all([
      estado('ZZ1', 'grpc-ctx-0001'),
      estado('ZZ1', 'grpc-ctx-0002'),
    ]);

    expect(resultados.map((r) => r.error)).toEqual([undefined, undefined]);
    // Dos llamadas a la vez no se mezclan
    expect(vistos.map((c) => c.requestId).sort()).toEqual(['grpc-ctx-0001', 'grpc-ctx-0002']);
    expect(vistos[0]).toMatchObject({ ip: '127.0.0.1', usuario: null });
  });

  it('la línea de acceso lleva el id, el método, el código y la IP', async () => {
    await estado('ZZ1', 'grpc-log-0001');
    await new Promise((resolver) => setTimeout(resolver, 20));

    expect(lineas().find((l) => l.includes('grpc-log-0001'))).toMatch(
      /\[gRPC\] \[grpc-log-0001\] \[traceId=[0-9a-f]{32} spanId=[0-9a-f]{16}\] \/quinde\.flights\.v1\.FlightsService\/GetFlightStatus OK [\d.]+ms ip=127\.0\.0\.1/,
    );
  });

  it('un error interno es INTERNAL sin detalle; el stack queda en el log con el id', async () => {
    const resultado = await estado('ZZ2', 'grpc-log-0002');
    await new Promise((resolver) => setTimeout(resolver, 20));

    expect(resultado.error?.code).toBe(EstadoGrpc.INTERNAL);
    expect(resultado.error?.details).toBe('Internal Server Error');
    expect(problemaDe(resultado.error)).toEqual({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      code: 'VALIDATION_FAILED',
    });
    const todo = JSON.stringify(resultado.error?.metadata.toJSON());
    expect(todo).not.toMatch(/Fallo interno|\/home\/|reserva_cabecera|\.ts:\d/);

    const delId = lineas().filter((l) => l.includes('grpc-log-0002'));
    expect(delId.some((l) => l.includes('[Errores]') && l.includes('→ 500'))).toBe(true);
    expect(delId.some((l) => l.includes('[gRPC]') && l.includes('INTERNAL'))).toBe(true);
    expect(lineas().some((l) => l.includes('Fallo interno en'))).toBe(true);
  });

  it('con la base caída es UNAVAILABLE con retry-after, como el 503 de REST', async () => {
    const resultado = await estado('ZZ3', 'grpc-log-0003');

    expect(resultado.error?.code).toBe(EstadoGrpc.UNAVAILABLE);
    expect(resultado.error?.details).toBe('The database is temporarily unavailable');
    expect(valorDe(resultado.error?.metadata, 'problem-status')).toBe('503');
    expect(valorDe(resultado.error?.metadata, 'retry-after')).toBe('5');
    expect(JSON.stringify(problemaDe(resultado.error))).not.toMatch(/5999|127\.0\.0\.1|localhost/);
  });
});

describe('gRPC: solo RPC públicas', () => {
  class Rpcs {
    @Publico()
    publica() {}

    privada() {}
  }
  const contexto = (handler: () => void) =>
    ({ getHandler: () => handler, getClass: () => Rpcs }) as unknown as ExecutionContext;
  const guard = new GuardSoloPublicoGrpc(new Reflector());

  it('una RPC con @Publico() pasa', () => {
    expect(guard.canActivate(contexto(Rpcs.prototype.publica))).toBe(true);
  });

  it('una RPC sin @Publico() es 401 (UNAUTHENTICATED), sin token posible', () => {
    let error: unknown;
    try {
      guard.canActivate(contexto(Rpcs.prototype.privada));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ErrorNegocio);
    expect((error as ErrorNegocio).status).toBe(401);
    expect(codigoGrpc((error as ErrorNegocio).status)).toBe(EstadoGrpc.UNAUTHENTICATED);
  });
});

describe('gRPC apagado (GRPC_ENABLED=false)', () => {
  const OBLIGATORIAS = {
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/booking_db?schema=vuelos',
    PORT: '3000',
    NODE_ENV: 'test',
    JWT_SECRET: 'j'.repeat(32),
    WEBHOOK_SECRET_KEY: 'w'.repeat(32),
  };
  const config = (valores: Record<string, unknown>) =>
    ({ get: (clave: string) => valores[clave] }) as unknown as ConfigService;

  it('sin la variable está apagado y el puerto por defecto es 50051', () => {
    expect(configuracionGrpc(config({}))).toEqual({ habilitado: false, puerto: 50051 });
    expect(configuracionGrpc(config({ GRPC_ENABLED: 'false', GRPC_PORT: 6000 }))).toEqual({
      habilitado: false,
      puerto: 6000,
    });
    expect(configuracionGrpc(config({ GRPC_ENABLED: 'true', GRPC_PORT: 6000 }))).toEqual({
      habilitado: true,
      puerto: 6000,
    });
  });

  it.each([
    [{ GRPC_ENABLED: 'si' }, 'GRPC_ENABLED debe ser true o false'],
    [{ GRPC_PORT: '70000' }, 'GRPC_PORT debe estar entre 1 y 65535'],
    [{ GRPC_PORT: 'cincuenta' }, 'GRPC_PORT debe ser un número entero'],
  ])('la API no arranca con %j', (valores, mensaje) => {
    expect(() => validarEntorno({ ...OBLIGATORIAS, ...valores })).toThrow(mensaje);
  });

  it('el puerto no se abre, la llamada no llega y REST responde igual', async () => {
    const puerto = await puertoLibre();
    const app = await crearApp();
    const cliente = new ClienteGrpc(puerto);
    try {
      expect(await iniciarGrpc(app, { habilitado: false, puerto })).toBe(false);

      expect(await aceptaConexiones(puerto)).toBe(false);
      const resultado = await cliente.llamar('GetFlightStatus', {
        flightNumber: 'AV1500',
        date: fechaEn(5),
      });
      expect(resultado.error?.code).toBe(EstadoGrpc.UNAVAILABLE);
      await request(app.getHttpServer()).get('/flights/v1/health').expect(200);
    } finally {
      cliente.cerrar();
      await app.close();
    }
  });

  it('encendido, el mismo puerto sí acepta conexiones (la prueba de arriba no es en falso)', async () => {
    const puerto = await puertoLibre();
    const app = await crearApp([], { grpc: puerto });
    try {
      expect(await aceptaConexiones(puerto)).toBe(true);
    } finally {
      await app.close();
    }
    expect(await aceptaConexiones(puerto)).toBe(false);
  });
});
