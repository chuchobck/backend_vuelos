import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { LoggerPorPeticion } from '../src/common/logger/logger-por-peticion';
import { validarEntorno } from '../src/config/entorno';
import { Observabilidad } from '../src/observabilidad/observabilidad';
import { BandejaEventosRepository } from '../src/modules/vuelos/operaciones/webhook/bandeja-eventos.repository';
import { PrismaService } from '../src/prisma/prisma.service';
import { RelevoEventos } from '../src/modules/vuelos/operaciones/webhook/relevo-eventos';
import type { CadenaBusqueda } from './utils/busqueda';
import type { AppCatalogo } from './utils/catalogo';
import { ClienteGrpc, puertoLibre } from './utils/grpc';
import { LimitesReiniciables } from './utils/limites';
import { LogEnMemoria } from './utils/log-en-memoria';
import { IdentityTokenFalso, NotifierFalso } from './utils/notifier-falso';
import { RecolectorOtlp, SpanRecibido } from './utils/recolector-otlp';
import { RelojDePrueba } from './utils/reloj';

/**
 * Observabilidad del core (fase 7c, docs/OBSERVABILIDAD.md del gateway): las trazas que de verdad
 * salen por OTLP/HTTP (a un recolector falso), la propagación del traceparent en REST y en gRPC,
 * la traza que viaja por la bandeja hasta el notifier y lo que se expone en /metrics.
 * WEBHOOKS_MODE=notifier (la bandeja se usa). La entrega a terceros, que es de modo local, está
 * en observabilidad-local.e2e-spec.ts.
 *
 * El entorno se fija antes de importar AppModule (ConfigModule lo valida al importarse).
 */

const reloj = new RelojDePrueba();
const limites = new LimitesReiniciables();
const log = new LogEnMemoria();
const entornoAnterior: Record<string, string | undefined> = {};
let recolector: RecolectorOtlp;
let notifier: NotifierFalso;
let identity: IdentityTokenFalso;
let puertoMetricas: number;
let puertoGrpc: number;

const SERVIDOR = 2;
const INTERNO = 1;
const CLIENTE = 3;

beforeAll(async () => {
  recolector = await new RecolectorOtlp().iniciar();
  notifier = await NotifierFalso.crear();
  identity = await IdentityTokenFalso.crear();
  puertoMetricas = await puertoLibre();
  puertoGrpc = await puertoLibre();
  const entorno = {
    WEBHOOKS_MODE: 'notifier',
    NOTIFIER_URL: notifier.url,
    IDENTITY_TOKEN_URL: identity.urlToken,
    NOTIFIER_CLIENT_ID: 'core-vuelos-e2e',
    NOTIFIER_CLIENT_SECRET: 'secreto-del-cliente-core-vuelos-de-prueba-77',
    EVENT_RELAY_JOB_ENABLED: 'false',
    OTEL_EXPORTER_OTLP_ENDPOINT: recolector.url,
    METRICS_PORT: String(puertoMetricas),
    RATE_LIMIT_MAX: '100000',
  };
  for (const [nombre, valor] of Object.entries(entorno)) {
    entornoAnterior[nombre] = process.env[nombre];
    process.env[nombre] = valor;
  }
});

afterAll(async () => {
  await notifier.caer();
  await identity.caer();
  await recolector.detener();
  for (const [nombre, valor] of Object.entries(entornoAnterior)) {
    if (valor === undefined) delete process.env[nombre];
    else process.env[nombre] = valor;
  }
});

const dormir = (ms: number) => new Promise((listo) => setTimeout(listo, ms));
const hex = (largo: number) => randomUUID().replace(/-/g, '').padEnd(largo, '0').slice(0, largo);
const traceparentDe = (traceId: string, spanId: string, bandera = '01') =>
  `00-${traceId}-${spanId}-${bandera}`;

describe('Observabilidad del core', () => {
  let c: AppCatalogo;
  let app: INestApplication;
  let prisma: PrismaService;
  let k: CadenaBusqueda;
  let relevo: RelevoEventos;
  let bandeja: BandejaEventosRepository;
  let utilidades: typeof import('./utils/reserva') &
    typeof import('./utils/busqueda') &
    typeof import('./utils/catalogo') &
    typeof import('./utils/postventa') &
    typeof import('./utils/auth');
  let grpc: ClienteGrpc;
  const clientes: Array<{ id: string; token: string }> = [];
  /** Todo lo que se mandó a la API y lo que se supo de lo creado, para el escaneo final. */
  const secretos: string[] = [];
  /** Ids de reserva: el log de acceso lleva la PLANTILLA, no la URL con el id. */
  const idsReserva: string[] = [];

  /** Envía a OTLP lo que haya en la cola y devuelve los spans de la traza, esperando `cuantos`. */
  const spansDe = async (traceId: string, cuantos: number): Promise<SpanRecibido[]> => {
    const proveedor = (
      app.get(Observabilidad).trazas as unknown as { proveedor: { forceFlush(): Promise<void> } }
    ).proveedor;
    const fin = Date.now() + 8_000;
    do {
      await proveedor.forceFlush();
      if (recolector.deTraza(traceId).length >= cuantos) break;
      await dormir(30);
    } while (Date.now() < fin);
    return recolector.deTraza(traceId);
  };
  const porNombre = (spans: SpanRecibido[], nombre: string) =>
    spans.filter((s) => s.nombre === nombre);

  const metricas = async (): Promise<string> =>
    (await fetch(`http://127.0.0.1:${puertoMetricas}/metrics`)).text();
  /** El valor de una serie sin etiquetas (core_outbox_pending), o undefined si no se publica. */
  const gauge = (texto: string, nombre: string): number | undefined => {
    const linea = texto.split('\n').find((l) => l.startsWith(`${nombre} `));
    return linea === undefined ? undefined : Number(linea.split(' ')[1]);
  };

  const reservarCadena = async (dueno: { token: string }, traceparent?: string) => {
    const retenido = await utilidades.buscarYRetener(
      app,
      dueno.token,
      [[k.origen, k.destino, k.fecha]],
      { adults: 1 },
    );
    const pasajero = utilidades.pasajero('ADULT', clientes.length);
    const referencia = utilidades.referenciaPago();
    secretos.push(pasajero.documentNumber, pasajero.contact.email, referencia, dueno.token);
    const prueba = utilidades.reservar(
      app,
      dueno.token,
      utilidades.cuerpoReserva(retenido.holdId, [pasajero], referencia),
    );
    if (traceparent) prueba.set('traceparent', traceparent);
    const respuesta = await prueba.expect(201);
    secretos.push(respuesta.body.pnr);
    idsReserva.push(respuesta.body.bookingId);
    return { respuesta, traceId: respuesta.headers['x-trace-id'] as string };
  };

  const drenar = async () => {
    notifier.reiniciar();
    reloj.adelantar(60 * 72);
    for (let i = 0; i < 50; i++) {
      const r = await relevo.ejecutar();
      if (r.publicados + r.reintentos + r.fallidos === 0) break;
    }
    reloj.alPresente();
    notifier.reiniciar();
  };

  beforeAll(async () => {
    const [reserva, busqueda, catalogo, postventa, auth] = await Promise.all([
      import('./utils/reserva'),
      import('./utils/busqueda'),
      import('./utils/catalogo'),
      import('./utils/postventa'),
      import('./utils/auth'),
    ]);
    utilidades = { ...reserva, ...busqueda, ...catalogo, ...postventa, ...auth };
    c = await catalogo.crearAppCatalogo({ reloj, limites, grpc: puertoGrpc });
    app = c.app;
    app.useLogger(log);
    prisma = c.prisma;
    relevo = app.get(RelevoEventos);
    bandeja = app.get(BandejaEventosRepository);
    grpc = new ClienteGrpc(puertoGrpc);
    k = await busqueda.crearCadena(c);
    await c
      .admin('patch', `${catalogo.ADMIN}/airlines/${k.aerolinea}`, {
        ticketPrefix: await catalogo.codigos.prefijoBoleto(prisma),
      })
      .expect(200);
    await c
      .admin('patch', `${catalogo.ADMIN}/departures/${k.salida}`, {
        cabins: [{ cabinClass: 'ECONOMY', totalSeats: 6 }],
      })
      .expect(200);
    await drenar();
    clientes.push(await utilidades.nuevoCliente(app));
  });

  afterAll(async () => {
    reloj.alPresente();
    grpc.cerrar();
    for (const dueno of clientes) await utilidades.cancelarReservasDe(app, dueno.token);
    await drenar();
    await c.admin('patch', `${utilidades.ADMIN}/airlines/${k.aerolinea}`, { ticketPrefix: null });
    await utilidades.darDeBajaCadena(c, k);
    await utilidades.desactivarUsuariosDePrueba(app);
    await c.cerrar();
  });

  beforeEach(() => {
    reloj.alPresente();
    limites.reiniciar();
  });

  describe('REST: el span SERVER continúa el traceparent recibido', () => {
    it('mismo trace-id, el parent correcto, X-Trace-Id y la plantilla de la ruta', async () => {
      const traceId = hex(32);
      const parent = hex(16);
      const respuesta = await request(app.getHttpServer())
        .get('/flights/v1/health')
        .set('traceparent', traceparentDe(traceId, parent))
        .expect(200);

      expect(respuesta.headers['x-trace-id']).toBe(traceId);
      const [servidor] = await spansDe(traceId, 1);
      expect(servidor).toMatchObject({
        servicio: 'quinde-core',
        tipo: SERVIDOR,
        nombre: 'GET /flights/v1/health',
        parentSpanId: parent,
        atributos: {
          'http.request.method': 'GET',
          'http.route': '/flights/v1/health',
          'http.response.status_code': 200,
          'quinde.request_id': respuesta.headers['x-request-id'],
        },
      });
      expect(servidor.recurso).toMatchObject({
        'service.name': 'quinde-core',
        'deployment.environment': 'test',
      });
    });

    it('sin traceparent abre una traza raíz', async () => {
      const respuesta = await request(app.getHttpServer()).get('/flights/v1/health').expect(200);
      const traceId = respuesta.headers['x-trace-id'] as string;
      expect(traceId).toMatch(/^[0-9a-f]{32}$/);
      const [servidor] = await spansDe(traceId, 1);
      expect(servidor.parentSpanId).toBe('');
      expect(servidor.tipo).toBe(SERVIDOR);
    });

    it.each([
      ['mayúsculas', traceparentDe(hex(32).toUpperCase(), hex(16))],
      ['versión ff', `ff-${hex(32)}-${hex(16)}-01`],
      ['campos de más', `${traceparentDe(hex(32), hex(16))}-extra`],
      ['ids en ceros', traceparentDe('0'.repeat(32), hex(16))],
      ['basura', 'esto-no-es-un-traceparent'],
    ])(
      'un traceparent inválido (%s) se ignora: la petición sigue y abre una raíz',
      async (_, tp) => {
        const respuesta = await request(app.getHttpServer())
          .get('/flights/v1/health')
          .set('traceparent', tp)
          .expect(200);
        const traceId = respuesta.headers['x-trace-id'] as string;
        expect(tp).not.toContain(traceId);
        const [servidor] = await spansDe(traceId, 1);
        expect(servidor.parentSpanId).toBe('');
      },
    );

    it('la ruta es siempre la plantilla, nunca la pedida; lo que no es ruta es __unmatched__', async () => {
      const dueno = clientes[0];
      const id = randomUUID();
      const pedida = await request(app.getHttpServer())
        .get(`/flights/v1/bookings/${id}`)
        .set('Authorization', `Bearer ${dueno.token}`)
        .expect(404);
      const inventada = await request(app.getHttpServer())
        .get(`/flights/v1/no-existe/${id}?correo=ana@e2e.quinde.example`)
        .expect(404);

      const [uno] = await spansDe(pedida.headers['x-trace-id'] as string, 1);
      const [dos] = await spansDe(inventada.headers['x-trace-id'] as string, 1);
      expect(uno.nombre).toBe('GET /flights/v1/bookings/{bookingId}');
      expect(uno.atributos['http.route']).toBe('/flights/v1/bookings/{bookingId}');
      expect(uno.atributos['http.response.status_code']).toBe(404);
      expect(dos.nombre).toBe('GET __unmatched__');
      for (const span of [uno, dos]) {
        expect(JSON.stringify(span)).not.toContain(id);
        expect(JSON.stringify(span)).not.toContain('ana@e2e');
      }
    });

    it('un error 5xx marca el span SERVER con error.type; un 4xx no', async () => {
      const cuatro = await request(app.getHttpServer()).get('/flights/v1/health').expect(200);
      const [ok] = await spansDe(cuatro.headers['x-trace-id'] as string, 1);
      expect(ok.estado.code ?? 0).not.toBe(2);

      const mala = await request(app.getHttpServer())
        .post('/flights/v1/search')
        .send({ itineraries: 'no' })
        .expect(400);
      const [cliente400] = await spansDe(mala.headers['x-trace-id'] as string, 1);
      expect(cliente400.atributos['http.response.status_code']).toBe(400);
      expect(cliente400.estado.code ?? 0).not.toBe(2);
    });
  });

  describe('gRPC: el span SERVER continúa el traceparent de la metadata', () => {
    const llamar = (cabeceras: Record<string, string> = {}) =>
      grpc.llamar('GetFlightStatus', { flightNumber: 'ZZ1', date: '2026-10-20' }, cabeceras);

    it('mismo trace-id, el parent correcto y rpc.* con su status', async () => {
      const traceId = hex(32);
      const parent = hex(16);
      const resultado = await llamar({ traceparent: traceparentDe(traceId, parent) });
      // El vuelo de la llamada no existe: NOT_FOUND es un resultado, no una falla del servidor
      expect(resultado.error?.code).toBe(5);

      const [servidor] = await spansDe(traceId, 1);
      expect(servidor).toMatchObject({
        servicio: 'quinde-core',
        tipo: SERVIDOR,
        nombre: 'quinde.flights.v1.FlightsService/GetFlightStatus',
        parentSpanId: parent,
        atributos: {
          'rpc.system': 'grpc',
          'rpc.service': 'quinde.flights.v1.FlightsService',
          'rpc.method': 'GetFlightStatus',
          'rpc.grpc.status_code': 5,
        },
      });
      expect(servidor.estado.code ?? 0).not.toBe(2);
    });

    it('sin traceparent abre una raíz; con uno inválido, también', async () => {
      const antes = new Set(recolector.spans.map((s) => s.spanId));
      await llamar();
      await llamar({ traceparent: 'basura' });
      let nuevos: SpanRecibido[];
      const fin = Date.now() + 8_000;
      do {
        await (
          app.get(Observabilidad).trazas as unknown as {
            proveedor: { forceFlush(): Promise<void> };
          }
        ).proveedor.forceFlush();
        nuevos = recolector.spans.filter(
          (s) => !antes.has(s.spanId) && s.nombre.endsWith('/GetFlightStatus'),
        );
        if (nuevos.length >= 2) break;
        await dormir(30);
      } while (Date.now() < fin);
      expect(nuevos.length).toBeGreaterThanOrEqual(2);
      for (const span of nuevos) expect(span.parentSpanId).toBe('');
    });

    it('el status gRPC de una falla del servidor deja el span en error', async () => {
      // UNIMPLEMENTED/INTERNAL/UNAVAILABLE son del servidor; NOT_FOUND no lo es (arriba)
      const traceId = hex(32);
      const resultado = await grpc.llamar(
        'SearchFlights',
        { itineraries: [] },
        { traceparent: traceparentDe(traceId, hex(16)) },
      );
      expect(resultado.error).toBeDefined();
      const [servidor] = await spansDe(traceId, 1);
      expect(servidor.atributos['rpc.grpc.status_code']).toBe(resultado.error?.code);
    });
  });

  describe('una reserva: la traza del hecho llega hasta el notifier', () => {
    let traceId: string;
    let parentCliente: string;
    let bookingId: string;
    let spans: SpanRecibido[];

    beforeAll(async () => {
      parentCliente = hex(16);
      const tp = hex(32);
      const resultado = await reservarCadena(clientes[0], traceparentDe(tp, parentCliente));
      traceId = resultado.traceId;
      bookingId = resultado.respuesta.body.bookingId;
      expect(traceId).toBe(tp);
      spans = await spansDe(traceId, 4);
    });

    it('jerarquía SERVER → INTERNAL → CLIENT del pago (y emitir boletos)', () => {
      const [servidor] = porNombre(spans, 'POST /flights/v1/bookings');
      const [reserva] = porNombre(spans, 'reserva.crear');
      const [pago] = porNombre(spans, 'POST /payments/authorize');
      const [emision] = porNombre(spans, 'reserva.emitir-boletos');

      expect(servidor).toMatchObject({ tipo: SERVIDOR, parentSpanId: parentCliente });
      expect(reserva).toMatchObject({ tipo: INTERNO, parentSpanId: servidor.spanId });
      expect(pago).toMatchObject({
        tipo: CLIENTE,
        parentSpanId: reserva.spanId,
        atributos: {
          'quinde.upstream': 'payments',
          'http.route': '/payments/authorize',
          'http.response.status_code': 200,
        },
      });
      expect(emision).toMatchObject({ tipo: INTERNO, parentSpanId: reserva.spanId });
      // Todos de la misma traza y ninguno con datos de la reserva
      expect(new Set(spans.map((s) => s.traceId))).toEqual(new Set([traceId]));
    });

    it('cada evento de la bandeja guarda el traceparent del contexto activo', async () => {
      const filas = await prisma.db.$queryRaw<Array<{ tipo: string; traceparent: string | null }>>`
        SELECT tipo, traceparent FROM vuelos.evento_saliente
         WHERE (sobre::jsonb) #>> '{data,bookingId}' = ${bookingId} ORDER BY creado_en, tipo`;
      expect(filas.map((f) => f.tipo).sort()).toEqual(
        ['booking.confirmed', 'booking.ticket_issued', 'booking.ticket_issuing'].sort(),
      );
      const [emision] = porNombre(spans, 'reserva.emitir-boletos');
      for (const fila of filas) {
        // Mismo trace-id; el padre es el span en que ocurrió el hecho (la emisión de boletos)
        expect(fila.traceparent).toBe(traceparentDe(traceId, emision.spanId));
      }
    });

    it('el relevo continúa ESA traza hacia el notifier: span CLIENT y traceparent nuevo', async () => {
      notifier.reiniciar();
      await relevo.ejecutar();
      const mias = notifier.recibidas.filter((r) => r.cuerpo.includes(bookingId));
      expect(mias).toHaveLength(3);

      const todos = await spansDe(traceId, 4 + 3);
      const clientes3 = todos.filter((s) => s.nombre === 'POST /internal/v1/events');
      expect(clientes3).toHaveLength(3);
      const [emision] = porNombre(spans, 'reserva.emitir-boletos');
      for (const span of clientes3) {
        expect(span).toMatchObject({
          tipo: CLIENTE,
          traceId,
          parentSpanId: emision.spanId,
          atributos: {
            'quinde.upstream': 'notifier',
            'http.route': '/internal/v1/events',
            'http.response.status_code': 202,
          },
        });
      }
      // Lo que recibió el notifier: la misma traza, con el span CLIENT de cada publicación como padre
      expect(new Set(mias.map((r) => r.traceparent))).toEqual(
        new Set(clientes3.map((s) => traceparentDe(traceId, s.spanId))),
      );
      for (const r of mias) expect(r.tracestate).toBeUndefined();
    });

    it('cada corrida del relevo es su propia traza raíz, aunque se llame dentro de otra', async () => {
      const { trazas } = app.get(Observabilidad);
      const externo = trazas.iniciar('externo', INTERNO, {});
      const antes = new Set(recolector.spans.map((s) => s.spanId));
      await trazas.conSpan(externo, () => relevo.ejecutar());
      externo.end();

      let corrida: SpanRecibido | undefined;
      const fin = Date.now() + 8_000;
      do {
        await (
          trazas as unknown as { proveedor: { forceFlush(): Promise<void> } }
        ).proveedor.forceFlush();
        corrida = recolector.spans.find(
          (s) => !antes.has(s.spanId) && s.nombre === 'job relevo-eventos',
        );
        if (corrida) break;
        await dormir(30);
      } while (Date.now() < fin);
      expect(corrida).toMatchObject({ tipo: INTERNO, parentSpanId: '', servicio: 'quinde-core' });
      expect(corrida?.traceId).not.toBe(externo.spanContext().traceId);
      expect(corrida?.traceId).not.toBe(traceId);
    });

    it('el log de una corrida del relevo lleva el traceId y el spanId de su traza', async () => {
      // Un logger real de la app (LoggerPorPeticion) sobre stdout; el de memoria no pone la traza
      const escrito: string[] = [];
      const espias = [process.stdout, process.stderr].map((salida) =>
        jest.spyOn(salida, 'write').mockImplementation((texto: string | Uint8Array) => {
          escrito.push(String(texto));
          return true;
        }),
      );
      app.useLogger(new LoggerPorPeticion());
      try {
        const dueno = await utilidades.nuevoCliente(app);
        clientes.push(dueno);
        const { traceId: delHecho } = await reservarCadena(dueno);
        await relevo.ejecutar();
        const lineas = escrito
          .join('')
          // eslint-disable-next-line no-control-regex
          .replace(/\u001b\[[0-9;]*m/g, '')
          .split('\n')
          .filter((l) => l.includes('[RelevoEventos]') && l.includes('intento'));
        expect(lineas.length).toBe(3);
        const trazas = new Set(
          lineas.map((l) => /\[traceId=([0-9a-f]{32}) spanId=([0-9a-f]{16})\]/.exec(l)?.[1]),
        );
        // Las tres líneas son de la misma corrida: una traza, que no es la de la reserva
        expect(trazas.size).toBe(1);
        const [traza] = [...trazas];
        expect(traza).toMatch(/^[0-9a-f]{32}$/);
        expect(traza).not.toBe(delHecho);
        // y la línea de acceso de una petición lleva el traceId del span SERVER
        const acceso = escrito
          .join('')
          .split('\n')
          .filter((l) => l.includes('[HTTP]'));
        expect(acceso.length).toBeGreaterThan(0);
        for (const linea of acceso)
          expect(linea).toMatch(/traceId=[0-9a-f]{32} spanId=[0-9a-f]{16}/);
        await utilidades.cancelarReservasDe(app, dueno.token);
      } finally {
        espias.forEach((e) => e.mockRestore());
        app.useLogger(log);
      }
    });
  });

  describe('/metrics', () => {
    it('solo en el puerto aparte: el público no lo sirve y el de métricas solo sirve GET /metrics', async () => {
      for (const ruta of ['/metrics', '/flights/v1/metrics']) {
        await request(app.getHttpServer()).get(ruta).expect(404);
      }
      const texto = await metricas();
      expect(texto).toContain('http_server_request_duration_seconds_bucket');
      expect(texto).toContain('quinde_build_info{service="quinde-core"');
      expect(texto).toContain('process_cpu_user_seconds_total');
      const otra = await fetch(`http://127.0.0.1:${puertoMetricas}/otra`);
      expect(otra.status).toBe(404);
      const post = await fetch(`http://127.0.0.1:${puertoMetricas}/metrics`, { method: 'POST' });
      expect(post.status).toBe(404);
    });

    it('las métricas de cliente, de reservas, de relevo y de jobs existen y son acotadas', async () => {
      const texto = await metricas();
      expect(texto).toMatch(
        /http_client_request_duration_seconds_count\{upstream="payments",method="POST",status="200"\} [1-9]/,
      );
      expect(texto).toMatch(
        /http_client_request_duration_seconds_count\{upstream="notifier",method="POST",status="202"\} [1-9]/,
      );
      expect(texto).toMatch(/core_bookings_total\{result="confirmed"\} [1-9]/);
      expect(texto).toMatch(/core_relay_publish_total\{result="published"\} [1-9]/);
      expect(texto).toMatch(/core_job_run_duration_seconds_count\{job="relevo-eventos"\} [1-9]/);
      // Las series de lista cerrada existen desde el arranque, aunque valgan 0
      for (const result of ['confirmed', 'pending_payment', 'failed', 'declined']) {
        expect(texto).toContain(`core_bookings_total{result="${result}"}`);
      }
    });

    it('cardinalidad acotada: 60 rutas distintas son una sola serie, nunca una ruta cruda', async () => {
      const dueno = clientes[0];
      await Promise.all(
        Array.from({ length: 30 }, () =>
          request(app.getHttpServer())
            .get(`/flights/v1/bookings/${randomUUID()}`)
            .set('Authorization', `Bearer ${dueno.token}`),
        ),
      );
      await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          request(app.getHttpServer()).get(`/flights/v1/inventada/${randomUUID()}/${i}`),
        ),
      );
      const texto = await metricas();
      const rutas = new Set(
        [...texto.matchAll(/http_server_requests_total\{[^}]*route="([^"]*)"/g)].map((m) => m[1]),
      );
      expect(rutas.has('/flights/v1/bookings/{bookingId}')).toBe(true);
      expect(rutas.has('__unmatched__')).toBe(true);
      for (const ruta of rutas) {
        expect(ruta).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
        expect(ruta).not.toContain('inventada');
      }
      expect(rutas.size).toBeLessThan(25);
      expect(texto).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    });

    it('core_outbox_pending y core_outbox_oldest_pending_seconds salen de la bandeja', async () => {
      await drenar();
      await dormir(1_100);
      let texto = await metricas();
      expect(gauge(texto, 'core_outbox_pending')).toBe(0);
      expect(gauge(texto, 'core_outbox_oldest_pending_seconds')).toBe(0);

      // Una reserva deja 3 eventos PENDIENTE; con el reloj 10 minutos adelante, el más viejo tiene ~600 s
      const dueno = await utilidades.nuevoCliente(app);
      clientes.push(dueno);
      await reservarCadena(dueno);
      const [{ n }] = await prisma.db.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM vuelos.evento_saliente WHERE estado = 'PENDIENTE'`;
      expect(n).toBe(3);
      reloj.adelantar(10);
      await dormir(1_100);
      texto = await metricas();
      expect(gauge(texto, 'core_outbox_pending')).toBe(3);
      const edad = gauge(texto, 'core_outbox_oldest_pending_seconds') ?? -1;
      expect(edad).toBeGreaterThanOrEqual(600);
      expect(edad).toBeLessThan(660);

      await relevo.ejecutar();
      await dormir(1_100);
      texto = await metricas();
      expect(gauge(texto, 'core_outbox_pending')).toBe(0);
      expect(gauge(texto, 'core_outbox_oldest_pending_seconds')).toBe(0);
    });

    it('si la base no contesta a tiempo, el raspado termina y el gauge no se publica (ni se cuelga)', async () => {
      await dormir(1_100);
      const colgada = jest
        .spyOn(bandeja, 'resumenPendientes')
        .mockImplementation(() => new Promise(() => undefined));
      try {
        const inicio = Date.now();
        const texto = await metricas();
        expect(Date.now() - inicio).toBeLessThan(5_000);
        expect(gauge(texto, 'core_outbox_pending')).toBeUndefined();
        expect(gauge(texto, 'core_outbox_oldest_pending_seconds')).toBeUndefined();
        expect(texto).toContain('http_server_request_duration_seconds_bucket');
      } finally {
        colgada.mockRestore();
      }
      await dormir(1_100);
      const rota = jest.spyOn(bandeja, 'resumenPendientes').mockRejectedValue(new Error('caída'));
      try {
        const texto = await metricas();
        expect(gauge(texto, 'core_outbox_pending')).toBeUndefined();
      } finally {
        rota.mockRestore();
      }
      await dormir(1_100);
      expect(gauge(await metricas(), 'core_outbox_pending')).toBe(0);
    }, 30_000);
  });

  describe('lo emitido no lleva datos de nadie', () => {
    it('ni pnr, ni correos, ni ids de reserva, ni tokens, ni IPs, ni cuerpos', async () => {
      const dueno = await utilidades.nuevoCliente(app);
      clientes.push(dueno);
      await reservarCadena(dueno);
      await relevo.ejecutar();
      for (const cliente of clientes) secretos.push(cliente.token);
      // Hasta aquí: reservas, cancelaciones, gRPC, errores y el relevo ya emitieron sus spans
      await utilidades.cancelarReservasDe(app, dueno.token);
      await recolector.esperar(1);
      await (
        app.get(Observabilidad).trazas as unknown as { proveedor: { forceFlush(): Promise<void> } }
      ).proveedor.forceFlush();
      await dormir(100);

      const spansYMetricas = [recolector.cuerpos.join('\n'), await metricas()];
      expect(recolector.cuerpos.length).toBeGreaterThan(0);
      const datos = [
        ...secretos,
        'Ana María',
        "D'Alessio",
        '@e2e.quinde.example',
        'Bearer ',
        'PAY-OK-',
        'paymentReference',
        'authorization',
      ];
      // Lo emitido por la observabilidad: ni siquiera el sub de un usuario ni una IP
      for (const texto of spansYMetricas) {
        for (const prohibido of [
          ...datos,
          ...idsReserva,
          ...clientes.map((x) => x.id),
          '127.0.0.1',
        ]) {
          expect(texto).not.toContain(prohibido);
        }
      }
      // El log tiene desde siempre el ip= y el user= de la línea de acceso; de ahí en adelante, nada:
      // tampoco un id de reserva, porque la línea lleva la plantilla de la ruta
      const lineasConDatos = log.lineas.filter((linea) =>
        [...datos, ...idsReserva].some((prohibido) => linea.includes(prohibido)),
      );
      expect(lineasConDatos).toEqual([]);
      // Solo los atributos permitidos (y los de la fase: rpc.*)
      const permitidos = new Set([
        'http.request.method',
        'http.route',
        'http.response.status_code',
        'quinde.upstream',
        'quinde.auth.mode',
        'quinde.request_id',
        'error.type',
        'rpc.system',
        'rpc.service',
        'rpc.method',
        'rpc.grpc.status_code',
      ]);
      for (const span of recolector.spans) {
        for (const nombre of Object.keys(span.atributos)) expect(permitidos.has(nombre)).toBe(true);
      }
    }, 30_000);
  });
});

describe('Validación del entorno de la observabilidad', () => {
  const base = {
    DATABASE_URL: 'postgresql://u@localhost:5432/booking_db',
    PORT: '3000',
    NODE_ENV: 'production',
    JWT_SECRET: 'j'.repeat(40),
    WEBHOOK_SECRET_KEY: 'w'.repeat(40),
  };
  const errorCon = (variables: Record<string, string>): string => {
    try {
      validarEntorno({ ...base, ...variables });
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error('validarEntorno aceptó la configuración');
  };

  it('sin ninguna arranca (valen los valores por defecto) y con valores válidos también', () => {
    expect(() => validarEntorno(base)).not.toThrow();
    expect(() =>
      validarEntorno({
        ...base,
        OTEL_SERVICE_NAME: 'quinde-core',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://jaeger:4318',
        OTEL_TRACES_SAMPLER_ARG: '0.25',
        TRACE_TRUST_INCOMING: 'false',
        METRICS_PORT: '9466',
      }),
    ).not.toThrow();
    // 0 apaga el servidor de métricas
    expect(() => validarEntorno({ ...base, METRICS_PORT: '0' })).not.toThrow();
  });

  it.each<[string, string, string]>([
    ['OTEL_SERVICE_NAME', 'Quinde Core', 'Quinde Core'],
    ['OTEL_EXPORTER_OTLP_ENDPOINT', 'ftp://jaeger:4318', 'ftp://jaeger'],
    ['OTEL_EXPORTER_OTLP_ENDPOINT', 'http://usuario:clave-secreta@jaeger:4318', 'clave-secreta'],
    ['OTEL_EXPORTER_OTLP_ENDPOINT', 'http://jaeger:4318/?token=abc', 'token=abc'],
    ['OTEL_TRACES_SAMPLER_ARG', '1.5', '1.5'],
    ['OTEL_TRACES_SAMPLER_ARG', 'casi-todas', 'casi-todas'],
    ['TRACE_TRUST_INCOMING', 'quizas', 'quizas'],
    ['METRICS_PORT', '-1', '-1'],
    ['METRICS_PORT', '70000', '70000'],
    ['METRICS_PORT', '9466.5', '9466.5'],
    ['METRICS_PORT', '3000', '3000'],
  ])('%s=%s no arranca y el mensaje nombra la variable, no su valor', (nombre, valor, secreto) => {
    const mensaje = errorCon({ [nombre]: valor });
    expect(mensaje).toContain(nombre);
    expect(mensaje).not.toContain(secreto);
  });

  it('METRICS_PORT no puede ser el del servidor gRPC', () => {
    const mensaje = errorCon({ GRPC_PORT: '9466', METRICS_PORT: '9466' });
    expect(mensaje).toContain('METRICS_PORT');
  });
});
