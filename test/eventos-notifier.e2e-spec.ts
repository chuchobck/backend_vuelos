import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Ajv, { ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import * as request from 'supertest';
import { validarEntorno } from '../src/config/entorno';
import { PrismaService } from '../src/prisma/prisma.service';
import { BandejaEventosRepository } from '../src/modules/vuelos/operaciones/webhook/bandeja-eventos.repository';
import { CifradoSecreto } from '../src/modules/vuelos/operaciones/webhook/cifrado-secreto';
import { ClienteNotifier } from '../src/modules/vuelos/operaciones/webhook/cliente-notifier';
import { ClienteTokenIdentity } from '../src/modules/vuelos/operaciones/webhook/cliente-token-identity';
import { PublicadorEventos } from '../src/modules/vuelos/operaciones/webhook/publicador-eventos';
import { RelevoEventos } from '../src/modules/vuelos/operaciones/webhook/relevo-eventos';
import { EVENTOS_WEBHOOK } from '../src/modules/vuelos/operaciones/webhook/webhook.modelo';
import { VencimientoRetenciones } from '../src/modules/vuelos/operaciones/retencion/vencimiento-retenciones';
import type { CadenaBusqueda } from './utils/busqueda';
import type { AppCatalogo } from './utils/catalogo';
import { LimitesReiniciables } from './utils/limites';
import { LogEnMemoria } from './utils/log-en-memoria';
import { IdentityTokenFalso, NotifierFalso } from './utils/notifier-falso';
import { esperarProblemDetails } from './utils/problem-details';
import { RelojDePrueba } from './utils/reloj';

/**
 * WEBHOOKS_MODE=notifier: el core guarda UN sobre por hecho en evento_saliente y RelevoEventos
 * lo publica en el notifier (aquí, NotifierFalso) con el token de identity (IdentityTokenFalso).
 * La configuración se valida al importar AppModule: las variables se fijan antes y todo lo que
 * importa AppModule (crear-app, catalogo, busqueda, reserva, postventa) se importa después.
 */

const RAIZ = resolve(__dirname, '..');
const SECRETO_CLIENTE = 'secreto-del-cliente-core-vuelos-de-prueba-77';
const ID_CLIENTE = 'core-vuelos-e2e';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- sobres que se validan con Ajv
type Json = Record<string, any>;

const reloj = new RelojDePrueba();
const limites = new LimitesReiniciables();
const log = new LogEnMemoria();
const entornoAnterior: Record<string, string | undefined> = {};
let notifier: NotifierFalso;
let identity: IdentityTokenFalso;

/** Los 12 esquemas copiados del notifier, compilados. */
function esquemasDelNotifier(): Map<string, ValidateFunction> {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const esquemas = new Map<string, ValidateFunction>();
  for (const tipo of EVENTOS_WEBHOOK) {
    const archivo = join(RAIZ, 'contracts', 'notifier-eventos', `${tipo}.v1.json`);
    esquemas.set(tipo, ajv.compile(JSON.parse(readFileSync(archivo, 'utf8'))));
  }
  return esquemas;
}

beforeAll(async () => {
  notifier = await NotifierFalso.crear();
  identity = await IdentityTokenFalso.crear();
  const entorno = {
    WEBHOOKS_MODE: 'notifier',
    NOTIFIER_URL: notifier.url,
    IDENTITY_TOKEN_URL: identity.urlToken,
    NOTIFIER_CLIENT_ID: ID_CLIENTE,
    NOTIFIER_CLIENT_SECRET: SECRETO_CLIENTE,
    EVENT_RELAY_JOB_ENABLED: 'false',
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
  for (const [nombre, valor] of Object.entries(entornoAnterior)) {
    if (valor === undefined) delete process.env[nombre];
    else process.env[nombre] = valor;
  }
});

describe('WEBHOOKS_MODE=notifier', () => {
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
  const clientes: Array<{ id: string; token: string }> = [];
  const esquemas = esquemasDelNotifier();
  const urlTercero = `https://tercero-e2e.example/hooks/${randomUUID()}`;
  /** Desde cuándo cuentan las filas de esta corrida (la base guarda las de corridas viejas). */
  const inicioSuite = new Date();
  /** Todo lo que el core respondió en esta suite, para el escaneo final. */
  const respuestas: string[] = [];

  const nuevoCliente = async () => {
    const creado = await utilidades.nuevoCliente(app);
    clientes.push(creado);
    return creado;
  };
  /** Una suscripción a los 12 eventos puesta a mano: /webhooks no existe en este modo. */
  const suscribirAMano = async (idPropietario: string) => {
    const secreto = app.get(CifradoSecreto).cifrar('secreto-del-tercero-de-prueba-01');
    await prisma.db.$executeRaw`
      WITH w AS (
        INSERT INTO vuelos.webhook_cabecera (id_propietario, url, secreto)
        VALUES (${idPropietario}, ${urlTercero}, ${secreto}) RETURNING id)
      INSERT INTO vuelos.webhook_detalle (webhook_id, tipo_evento_id)
      SELECT w.id, t.id FROM w CROSS JOIN vuelos.tipo_evento t`;
  };
  const reservarCadena = async (dueno: { token: string }): Promise<Json> => {
    const retenido = await utilidades.buscarYRetener(
      app,
      dueno.token,
      [[k.origen, k.destino, k.fecha]],
      { adults: 1 },
    );
    const respuesta = await utilidades
      .reservar(
        app,
        dueno.token,
        utilidades.cuerpoReserva(
          retenido.holdId,
          [utilidades.pasajero('ADULT', clientes.length)],
          utilidades.referenciaPago(),
        ),
      )
      .expect(201);
    respuestas.push(JSON.stringify(respuesta.body));
    return respuesta.body as Json;
  };
  const eventosDeReserva = (bookingId: string) =>
    prisma.db.$queryRaw<Array<{ tipo: string; sobre: string; id_propietario: string }>>`
      SELECT tipo, sobre, id_propietario FROM vuelos.evento_saliente
       WHERE (sobre::jsonb) #>> '{data,bookingId}' = ${bookingId}
       ORDER BY creado_en, tipo`;
  const entregasDe = (idPropietario: string) =>
    prisma.db.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM vuelos.webhook_entrega e
        JOIN vuelos.webhook_cabecera w ON w.id = e.webhook_id
       WHERE w.id_propietario = ${idPropietario}`.then((f) => f[0].n);
  const esperarSobreValido = (sobre: string) => {
    const json = JSON.parse(sobre) as Json;
    const validar = esquemas.get(json.eventType);
    expect(validar).toBeDefined();
    const valido = validar!(json);
    expect(validar!.errors ?? []).toEqual([]);
    expect(valido).toBe(true);
    return json;
  };

  /** Publica todo lo pendiente (de esta corrida o de corridas viejas) para empezar limpio. */
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
    c = await catalogo.crearAppCatalogo({ reloj, limites });
    app = c.app;
    app.useLogger(log);
    prisma = c.prisma;
    relevo = app.get(RelevoEventos);
    bandeja = app.get(BandejaEventosRepository);
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
  });

  afterAll(async () => {
    reloj.alPresente();
    for (const dueno of clientes) await utilidades.cancelarReservasDe(app, dueno.token);
    await prisma.db.webhook_cabecera.updateMany({
      where: { url: urlTercero },
      data: { activo: false },
    });
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

  describe('la bandeja: un sobre por hecho, dentro de su transacción', () => {
    let a: { id: string; token: string };
    let reservaA: Json;

    beforeAll(async () => {
      a = await nuevoCliente();
      await suscribirAMano(a.id);
      reservaA = await reservarCadena(a);
    });

    it('reservar deja UNA fila por evento en evento_saliente y CERO en webhook_entrega', async () => {
      expect(reservaA.status).toBe('CONFIRMED');
      const filas = await eventosDeReserva(reservaA.bookingId);
      const tipos = filas.map((f) => f.tipo);
      expect(tipos).toEqual(expect.arrayContaining(['booking.confirmed']));
      expect(new Set(tipos).size).toBe(tipos.length);
      for (const f of filas) {
        const sobre = esperarSobreValido(f.sobre);
        expect(sobre).toMatchObject({
          schemaVersion: '1.0',
          ownerId: a.id,
          data: { bookingId: reservaA.bookingId, pnr: reservaA.pnr },
        });
        expect(f.id_propietario).toBe(a.id);
      }
      // El dueño tiene una suscripción activa a los 12, y aun así el core no reparte
      expect(await entregasDe(a.id)).toBe(0);
    });

    it('un cambio de horario deja un evento por reserva viva, cada uno con su eventId y su dueño', async () => {
      const b = await nuevoCliente();
      const reservaB = await reservarCadena(b);
      const antes = new Set(
        (
          await prisma.db.$queryRaw<Array<{ id: string }>>`
            SELECT id_evento::text AS id FROM vuelos.evento_saliente WHERE tipo = 'flight.schedule_changed'`
        ).map((f) => f.id),
      );
      const salida = new Date(utilidades.enDias(20, 15));
      await c
        .admin('patch', `${utilidades.ADMIN}/departures/${k.salida}`, {
          status: 'DELAYED',
          estimatedDeparture: new Date(salida.getTime() + 40 * 60_000).toISOString(),
        })
        .expect(200);
      const nuevos = (
        await prisma.db.$queryRaw<Array<{ id: string; sobre: string; id_propietario: string }>>`
          SELECT id_evento::text AS id, sobre, id_propietario FROM vuelos.evento_saliente
           WHERE tipo = 'flight.schedule_changed' AND (sobre::jsonb) #>> '{data,segmentId}' = ${k.salida}`
      ).filter((f) => !antes.has(f.id));
      expect(nuevos).toHaveLength(2);
      expect(new Set(nuevos.map((n) => n.id)).size).toBe(2);
      const porReserva = new Map(
        nuevos.map((n) => [esperarSobreValido(n.sobre).data.bookingId as string, n]),
      );
      expect(porReserva.get(reservaA.bookingId)?.id_propietario).toBe(a.id);
      expect(porReserva.get(reservaB.bookingId)?.id_propietario).toBe(b.id);
      expect(JSON.parse(porReserva.get(reservaB.bookingId)!.sobre).data).toEqual({
        bookingId: reservaB.bookingId,
        pnr: reservaB.pnr,
        status: 'CONFIRMED',
        flightNumber: k.vuelo,
        segmentId: k.salida,
      });
    });

    it('cancelar deja booking.cancelled con el reembolso como texto', async () => {
      const d = await nuevoCliente();
      const reservaD = await reservarCadena(d);
      expect(await utilidades.cancelarReservasDe(app, d.token)).toBe(1);
      const [cancelada] = (await eventosDeReserva(reservaD.bookingId)).filter(
        (f) => f.tipo === 'booking.cancelled',
      );
      const sobre = esperarSobreValido(cancelada.sobre);
      expect(sobre.data).toMatchObject({ status: 'CANCELLED', bookingId: reservaD.bookingId });
      expect(sobre.data.refundAmount).toMatch(/^\d+\.\d{2}$/);
    });

    it('un hold vencido deja hold.expired, una sola vez', async () => {
      const e = await nuevoCliente();
      const retenido = await utilidades.buscarYRetener(
        app,
        e.token,
        [[k.origen, k.destino, k.fecha]],
        {
          adults: 1,
        },
      );
      reloj.adelantar(16);
      await app.get(VencimientoRetenciones).ejecutar();
      await app.get(VencimientoRetenciones).ejecutar();
      const filas = await prisma.db.$queryRaw<Array<{ sobre: string; id_propietario: string }>>`
        SELECT sobre, id_propietario FROM vuelos.evento_saliente
         WHERE tipo = 'hold.expired' AND (sobre::jsonb) #>> '{data,holdId}' = ${retenido.holdId}`;
      expect(filas).toHaveLength(1);
      expect(filas[0].id_propietario).toBe(e.id);
      expect(esperarSobreValido(filas[0].sobre).data).toEqual({
        holdId: retenido.holdId,
        status: 'EXPIRED',
      });
    });

    it('cada uno de los 12 tipos genera un sobre que cumple su esquema del notifier', async () => {
      const publicador = app.get(PublicadorEventos);
      const tipos = new Set<string>();
      await prisma.transaccionAuditada(async (tx) => {
        for (const tipo of EVENTOS_WEBHOOK.filter((t) => t.startsWith('booking.'))) {
          await publicador.deReserva(tx, reservaA.bookingId, tipo, reloj.ahora());
        }
        await publicador.deVuelo(tx, k.salida, 'flight.cancelled', reloj.ahora());
      });
      const filas = await prisma.db.$queryRaw<Array<{ tipo: string; sobre: string }>>`
        SELECT tipo, sobre FROM vuelos.evento_saliente
         WHERE creado_en >= ${inicioSuite}::timestamptz`;
      for (const f of filas) {
        esperarSobreValido(f.sobre);
        tipos.add(f.tipo);
      }
      expect([...tipos].sort()).toEqual([...EVENTOS_WEBHOOK].sort());
    });

    it('si la transacción del hecho se deshace, no queda evento', async () => {
      const antes = (await eventosDeReserva(reservaA.bookingId)).length;
      await expect(
        prisma.transaccionAuditada(async (tx) => {
          await app
            .get(PublicadorEventos)
            .deReserva(tx, reservaA.bookingId, 'booking.changed', reloj.ahora());
          throw new Error('se deshace');
        }),
      ).rejects.toThrow('se deshace');
      expect(await eventosDeReserva(reservaA.bookingId)).toHaveLength(antes);
    });

    it('un evento que no es suscribible se ignora, como en local', async () => {
      const antes = (await eventosDeReserva(reservaA.bookingId)).length;
      await prisma.transaccionAuditada((tx) =>
        app
          .get(PublicadorEventos)
          .deReserva(tx, reservaA.bookingId, 'booking.created', reloj.ahora()),
      );
      expect(await eventosDeReserva(reservaA.bookingId)).toHaveLength(antes);
    });
  });

  describe('el relevo al notifier', () => {
    /** Eventos sintéticos en la bandeja: lo que se prueba es el relevo, no el hecho. */
    const encolar = async (cantidad: number, opciones: { reintentarHasta?: Date } = {}) => {
      const ahora = reloj.ahora();
      const hasta = opciones.reintentarHasta ?? new Date(ahora.getTime() + 48 * 3_600_000);
      const filas = await prisma.db.$queryRaw<Array<{ id: string }>>`
        WITH nuevos AS (SELECT gen_random_uuid() AS id, gen_random_uuid() AS reserva, gen_random_uuid() AS dueno
                          FROM generate_series(1, ${cantidad}))
        INSERT INTO vuelos.evento_saliente
               (id_evento, tipo, id_propietario, sobre, proximo_intento, reintentar_hasta, creado_en)
        SELECT n.id, 'booking.confirmed', n.dueno::text,
               jsonb_build_object('eventId', n.id::text, 'eventType', 'booking.confirmed',
                                  'schemaVersion', '1.0', 'occurredAt', '2026-10-16T14:30:00.000Z',
                                  'ownerId', n.dueno::text,
                                  'data', jsonb_build_object('bookingId', n.reserva::text, 'pnr', 'Q7K2MX',
                                                             'status', 'CONFIRMED'))::text,
               ${ahora}::timestamptz, ${hasta}::timestamptz, ${ahora}::timestamptz
          FROM nuevos n
        RETURNING id_evento::text AS id`;
      return filas.map((f) => f.id);
    };
    const fila = async (id: string) =>
      (
        await prisma.db.$queryRaw<
          Array<{
            estado: string;
            intentos: number;
            sobre: string;
            proximo: Date;
            codigo: number | null;
            error: string | null;
            publicado: Date | null;
          }>
        >`
          SELECT estado::text AS estado, intentos::int AS intentos, sobre, proximo_intento AS proximo,
                 ultimo_codigo_http AS codigo, ultimo_error AS error, publicado_en AS publicado
            FROM vuelos.evento_saliente WHERE id_evento = ${id}::uuid`
      )[0];
    const segundosHasta = (fecha: Date) =>
      Math.round((fecha.getTime() - reloj.ahora().getTime()) / 1000);

    beforeEach(async () => {
      await drenar();
      identity.reiniciar();
      app.get(ClienteTokenIdentity).invalidar();
    });

    it('202 publica el sobre guardado, byte a byte, con el token de identity', async () => {
      const [id] = await encolar(1);
      const guardado = (await fila(id)).sobre;
      expect(await relevo.ejecutar()).toMatchObject({ publicados: 1 });
      const [recibida] = notifier.de(id);
      expect(recibida.cuerpo).toBe(guardado);
      expect(recibida.ruta).toBe('/internal/v1/events');
      expect(recibida.contentType).toBe('application/json');
      expect(recibida.autorizacion).toBe(`Bearer ${identity.entregados[0]}`);
      expect(await fila(id)).toMatchObject({
        estado: 'PUBLICADO',
        intentos: 1,
        codigo: 202,
        error: null,
      });
      // El token se pidió con Basic y client_credentials con events:publish
      const [pedido] = identity.pedidos;
      expect(pedido.autorizacion).toBe(
        `Basic ${Buffer.from(`${ID_CLIENTE}:${SECRETO_CLIENTE}`).toString('base64')}`,
      );
      expect(new URLSearchParams(pedido.cuerpo).get('grant_type')).toBe('client_credentials');
      expect(new URLSearchParams(pedido.cuerpo).get('scope')).toBe('events:publish');
    });

    it('200 (ya estaba) también cuenta como PUBLICADO', async () => {
      const [id] = await encolar(1);
      notifier.responder({ status: 200 });
      await relevo.ejecutar();
      expect(await fila(id)).toMatchObject({ estado: 'PUBLICADO', codigo: 200 });
    });

    it('503 con Retry-After: reintento cuando dice, con el MISMO cuerpo byte a byte', async () => {
      const [id] = await encolar(1);
      notifier.responder({ status: 503, cabeceras: { 'Retry-After': '120' } });
      await relevo.ejecutar();
      const despues = await fila(id);
      expect(despues).toMatchObject({
        estado: 'PENDIENTE',
        intentos: 1,
        codigo: 503,
        error: 'HTTP_503',
      });
      expect(segundosHasta(despues.proximo)).toBe(120);
      // Antes de la hora no se vuelve a intentar
      reloj.adelantar(1);
      await relevo.ejecutar();
      expect(notifier.de(id)).toHaveLength(1);
      reloj.adelantar(1);
      await relevo.ejecutar();
      const [primera, segunda] = notifier.de(id);
      expect(segunda.cuerpo).toBe(primera.cuerpo);
      expect(await fila(id)).toMatchObject({ estado: 'PUBLICADO', intentos: 2 });
    });

    it('500, red caída y plazo agotado se reintentan con el mismo cuerpo', async () => {
      const [id] = await encolar(1);
      notifier.responder({ status: 500 });
      await relevo.ejecutar();
      expect(await fila(id)).toMatchObject({ estado: 'PENDIENTE', error: 'HTTP_500' });

      await notifier.caer();
      reloj.adelantar(1);
      await relevo.ejecutar();
      expect(await fila(id)).toMatchObject({
        estado: 'PENDIENTE',
        intentos: 2,
        codigo: null,
        error: 'ECONNREFUSED',
      });
      await notifier.levantar();

      notifier.responder({ status: 202, demoraMs: 6_000 });
      reloj.adelantar(1);
      const antes = Date.now();
      await relevo.ejecutar();
      expect(Date.now() - antes).toBeLessThan(5_900);
      expect(await fila(id)).toMatchObject({ estado: 'PENDIENTE', intentos: 3, error: 'TIMEOUT' });

      reloj.adelantar(3);
      await relevo.ejecutar();
      const recibidas = notifier.de(id);
      expect(recibidas.length).toBeGreaterThanOrEqual(3);
      expect(new Set(recibidas.map((r) => r.cuerpo)).size).toBe(1);
      expect(await fila(id)).toMatchObject({ estado: 'PUBLICADO', intentos: 4 });
    });

    it.each([400, 409, 413, 415, 422])(
      '%s es un error del publicador: FALLIDO sin reintento',
      async (status) => {
        const [id] = await encolar(1);
        notifier.responder({ status });
        await relevo.ejecutar();
        expect(await fila(id)).toMatchObject({ estado: 'FALLIDO', intentos: 1, codigo: status });
        reloj.adelantar(60 * 49);
        await relevo.ejecutar();
        expect(notifier.de(id)).toHaveLength(1);
        expect(log.texto()).toContain(
          `Evento ${id} (booking.confirmed) rechazado por el notifier con HTTP ${status}`,
        );
      },
    );

    it('401: pide un token nuevo y reintenta en el mismo intento', async () => {
      const [id] = await encolar(1);
      notifier.responder({ status: 401 });
      await relevo.ejecutar();
      const [primera, segunda] = notifier.de(id);
      expect(identity.pedidos).toHaveLength(2);
      expect(primera.autorizacion).toBe(`Bearer ${identity.entregados[0]}`);
      expect(segunda.autorizacion).toBe(`Bearer ${identity.entregados[1]}`);
      expect(segunda.cuerpo).toBe(primera.cuerpo);
      expect(await fila(id)).toMatchObject({ estado: 'PUBLICADO', intentos: 1 });
    });

    it('el token se reutiliza entre eventos y se renueva al acercarse su vencimiento', async () => {
      await encolar(10);
      await relevo.ejecutar();
      expect(identity.pedidos).toHaveLength(1);
      reloj.adelantar(13);
      await encolar(1);
      await relevo.ejecutar();
      expect(identity.pedidos).toHaveLength(1);
      // 15 minutos de vigencia: a menos de uno de vencer se pide otro
      reloj.adelantar(1.5);
      const [id] = await encolar(1);
      await relevo.ejecutar();
      expect(identity.pedidos).toHaveLength(2);
      expect(notifier.de(id)[0].autorizacion).toBe(`Bearer ${identity.entregados[1]}`);
    });

    it('sin token (identity caído o con error) el evento sigue PENDIENTE y no se publica', async () => {
      const [id] = await encolar(1);
      identity.fallaCon = 500;
      await relevo.ejecutar();
      expect(notifier.de(id)).toHaveLength(0);
      expect(await fila(id)).toMatchObject({ estado: 'PENDIENTE', error: 'TOKEN_HTTP_500' });
    });

    it('esperas crecientes: 5 s, 30 s, 2 min, 10 min, 30 min y luego cada hora', async () => {
      const [id] = await encolar(1);
      notifier.porDefecto = () => ({ status: 500 });
      const esperas: number[] = [];
      for (let i = 0; i < 7; i++) {
        await relevo.ejecutar();
        const { proximo } = await fila(id);
        const espera = segundosHasta(proximo);
        esperas.push(espera);
        reloj.adelantar(espera / 60);
      }
      expect(esperas).toEqual([5, 30, 120, 600, 1800, 3600, 3600]);
    });

    it('pasadas las 48 h queda FALLIDO con un aviso', async () => {
      const [id] = await encolar(1, { reintentarHasta: new Date(reloj.ahora().getTime() - 1000) });
      notifier.responder({ status: 503 });
      await relevo.ejecutar();
      expect(await fila(id)).toMatchObject({ estado: 'FALLIDO', codigo: 503 });
      expect(log.texto()).toContain(
        `Evento ${id} (booking.confirmed) sin publicar tras 48 h (HTTP_503)`,
      );
    });

    it('un evento pendiente de más de 15 minutos deja un aviso en el log', async () => {
      await encolar(1);
      notifier.porDefecto = () => ({ status: 503 });
      reloj.adelantar(16);
      await relevo.ejecutar();
      expect(log.texto()).toMatch(
        /El evento pendiente más viejo lleva 1[67] minutos sin publicarse/,
      );
    });

    it('dos relevos a la vez con 60 eventos: cada eventId se publica una sola vez', async () => {
      const ids = await encolar(60);
      notifier.porDefecto = () => ({ status: 202, demoraMs: 15 });
      const otro = new RelevoEventos(
        bandeja,
        app.get(ClienteNotifier),
        app.get(ClienteTokenIdentity),
        reloj,
        app.get(ConfigService),
      );
      const [uno, dos] = await Promise.all([relevo.ejecutar(), otro.ejecutar()]);
      expect(uno.publicados + dos.publicados).toBe(60);
      const veces = notifier.vecesPorEvento();
      for (const id of ids) expect(veces.get(id)).toBe(1);
    });

    it('una fila que otro proceso tiene bloqueada se salta (SKIP LOCKED), sin esperar', async () => {
      const [bloqueado, libre] = await encolar(2);
      const otraConexion = new Client({
        connectionString: app.get(ConfigService).getOrThrow('DATABASE_URL'),
      });
      await otraConexion.connect();
      try {
        await otraConexion.query('BEGIN');
        await otraConexion.query(
          'SELECT 1 FROM vuelos.evento_saliente WHERE id_evento = $1 FOR UPDATE',
          [bloqueado],
        );
        const tomados = await Promise.race([
          bandeja.reclamar(reloj.ahora(), 10, 60),
          new Promise<'esperó'>((listo) => setTimeout(() => listo('esperó'), 2_000)),
        ]);
        expect(tomados).not.toBe('esperó');
        expect((tomados as Array<{ idEvento: string }>).map((t) => t.idEvento)).toEqual([libre]);
      } finally {
        await otraConexion.query('ROLLBACK');
        await otraConexion.end();
      }
    });

    it('si el proceso muere con eventos tomados, vuelven solos al vencer el arrendamiento', async () => {
      const ids = await encolar(3);
      // Otro proceso los toma y "muere" sin publicar ni anotar nada
      expect(await bandeja.reclamar(reloj.ahora(), 10, 60)).toHaveLength(3);
      await relevo.ejecutar();
      expect(notifier.recibidas).toHaveLength(0);
      reloj.adelantar(61 / 60);
      await relevo.ejecutar();
      for (const id of ids)
        expect(await fila(id)).toMatchObject({ estado: 'PUBLICADO', intentos: 2 });
    });

    it('eventos:reencolar devuelve un FALLIDO a PENDIENTE y se publica el mismo sobre', async () => {
      const [id, otro] = await encolar(2);
      notifier.responder({ status: 422 }, { status: 422 });
      await relevo.ejecutar();
      expect((await fila(id)).estado).toBe('FALLIDO');
      const salida = await correrScript('scripts/reencolar-eventos.cjs', id);
      expect(salida.codigo).toBe(0);
      expect(salida.texto).toContain('Reencolados 1 eventos');
      expect(await fila(id)).toMatchObject({ estado: 'PENDIENTE', intentos: 0 });
      expect((await fila(otro)).estado).toBe('FALLIDO');
      reloj.alPresente();
      await relevo.ejecutar();
      const [primera, segunda] = notifier.de(id);
      expect(segunda.cuerpo).toBe(primera.cuerpo);
      expect(await fila(id)).toMatchObject({ estado: 'PUBLICADO', intentos: 1 });

      const todos = await correrScript('scripts/reencolar-eventos.cjs', '--todos-los-fallidos');
      expect(todos.texto).toMatch(/Reencolados \d+ eventos/);
      expect((await fila(otro)).estado).toBe('PENDIENTE');
      expect((await correrScript('scripts/reencolar-eventos.cjs', 'no-es-un-uuid')).codigo).toBe(2);
    });
  });

  describe('/webhooks lo sirve el notifier', () => {
    it.each([
      ['get', '/flights/v1/webhooks'],
      ['post', '/flights/v1/webhooks'],
      ['delete', `/flights/v1/webhooks/${randomUUID()}`],
    ] as const)('%s %s responde 404 ProblemDetails', async (metodo, ruta) => {
      const cliente = await nuevoCliente();
      const respuesta = await request(app.getHttpServer())
        [metodo](ruta)
        .set('Authorization', `Bearer ${cliente.token}`)
        .send({
          url: urlTercero,
          events: ['booking.confirmed'],
          secret: 'un-secreto-de-pruebas-1234',
        });
      respuestas.push(JSON.stringify(respuesta.body));
      expect(respuesta.status).toBe(404);
      esperarProblemDetails(respuesta);
    });
  });

  describe('nada sensible en el log, la bandeja ni las respuestas', () => {
    it('ni el client_secret, ni un token, ni la URL de una suscripción', async () => {
      expect(identity.entregados.length).toBeGreaterThan(0);
      const bandejaEntera = (
        await prisma.db.$queryRaw<Array<{ fila: string }>>`
          SELECT row_to_json(e)::text AS fila FROM vuelos.evento_saliente e`
      )
        .map((f) => f.fila)
        .join('\n');
      const publicado = notifier.recibidas.map((r) => r.cuerpo).join('\n');
      for (const texto of [log.texto(), bandejaEntera, publicado, respuestas.join('\n')]) {
        expect(texto).not.toContain(SECRETO_CLIENTE);
        expect(texto).not.toMatch(/tok-\d+-falso-de-prueba/);
        expect(texto).not.toContain(urlTercero);
        expect(texto).not.toContain('tercero-e2e.example');
      }
    });
  });
});

describe('Validación del entorno de WEBHOOKS_MODE=notifier', () => {
  const base = {
    DATABASE_URL: 'postgresql://u@localhost:5432/booking_db',
    PORT: '3000',
    NODE_ENV: 'production',
    JWT_SECRET: 'j'.repeat(40),
    WEBHOOK_SECRET_KEY: 'w'.repeat(40),
  };
  const notifierCompleto = {
    ...base,
    WEBHOOKS_MODE: 'notifier',
    NOTIFIER_URL: 'https://notifier.quinde.example',
    IDENTITY_TOKEN_URL: 'https://identity.quinde.example/oauth2/token',
    NOTIFIER_CLIENT_ID: 'core-vuelos',
    NOTIFIER_CLIENT_SECRET: 's'.repeat(40),
  };
  const errorCon = (variables: Record<string, string | undefined>): string => {
    try {
      validarEntorno(variables);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error('validarEntorno aceptó la configuración');
  };

  it('en local no se lee ninguna variable del notifier, aunque esté mal', () => {
    expect(() =>
      validarEntorno({ ...base, NOTIFIER_URL: 'nada', EVENT_RELAY_JOB_ENABLED: 'quizas' }),
    ).not.toThrow();
  });

  it('con las cuatro variables arranca', () => {
    expect(() => validarEntorno(notifierCompleto)).not.toThrow();
  });

  it.each<[string, Record<string, string | undefined>, string, string | undefined]>([
    ['sin NOTIFIER_URL', { NOTIFIER_URL: undefined }, 'NOTIFIER_URL es obligatoria', undefined],
    [
      'sin IDENTITY_TOKEN_URL',
      { IDENTITY_TOKEN_URL: undefined },
      'IDENTITY_TOKEN_URL es obligatoria',
      undefined,
    ],
    [
      'sin NOTIFIER_CLIENT_ID',
      { NOTIFIER_CLIENT_ID: undefined },
      'NOTIFIER_CLIENT_ID es obligatoria',
      undefined,
    ],
    [
      'sin NOTIFIER_CLIENT_SECRET',
      { NOTIFIER_CLIENT_SECRET: undefined },
      'NOTIFIER_CLIENT_SECRET es obligatoria',
      undefined,
    ],
    [
      'con un secreto corto',
      { NOTIFIER_CLIENT_SECRET: 'corto-secreto' },
      'al menos 16 caracteres',
      'corto-secreto',
    ],
    [
      'con NOTIFIER_URL http en producción',
      { NOTIFIER_URL: 'http://notifier-oculto.example' },
      'NOTIFIER_URL debe ser una URL https',
      'notifier-oculto',
    ],
    [
      'con credenciales en IDENTITY_TOKEN_URL',
      { IDENTITY_TOKEN_URL: 'https://yo:clave-secreta@identity.example/oauth2/token' },
      'IDENTITY_TOKEN_URL debe ser',
      'clave-secreta',
    ],
    [
      'con un modo desconocido',
      { WEBHOOKS_MODE: 'kafka-secreto' },
      'WEBHOOKS_MODE debe ser uno de',
      'kafka-secreto',
    ],
  ])(
    '%s no arranca y el mensaje nombra la variable, no su valor',
    (_caso, cambios, mensaje, valor) => {
      const texto = errorCon({ ...notifierCompleto, ...cambios });
      expect(texto).toContain(mensaje);
      if (valor) expect(texto).not.toContain(valor);
    },
  );
});

function correrScript(
  script: string,
  ...argumentos: string[]
): Promise<{ codigo: number; texto: string }> {
  return new Promise((resolver) => {
    execFile(
      process.execPath,
      [join(RAIZ, script), ...argumentos],
      { cwd: RAIZ, env: process.env },
      (error, stdout, stderr) => {
        const codigo = error ? Number((error as { code?: unknown }).code ?? 1) : 0;
        resolver({ codigo, texto: `${stdout}${stderr}` });
      },
    );
  });
}
