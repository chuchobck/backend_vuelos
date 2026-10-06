import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { CifradoSecreto } from '../src/modules/vuelos/operaciones/webhook/cifrado-secreto';
import {
  ClienteWebhook,
  PeticionWebhook,
  ResultadoWebhook,
} from '../src/modules/vuelos/operaciones/webhook/cliente-webhook';
import { ClienteWebhookHttp } from '../src/modules/vuelos/operaciones/webhook/cliente-webhook-http';
import {
  EntregaWebhooks,
  REGLAS_ENTREGA,
} from '../src/modules/vuelos/operaciones/webhook/entrega-webhooks';
import { EntregaRepository } from '../src/modules/vuelos/operaciones/webhook/entrega.repository';
import { PublicadorEventos } from '../src/modules/vuelos/operaciones/webhook/publicador-eventos';
import { firmaValida } from '../src/modules/vuelos/operaciones/webhook/firma-webhook';
import { VencimientoRetenciones } from '../src/modules/vuelos/operaciones/retencion/vencimiento-retenciones';
import { desactivarUsuariosDePrueba } from './utils/auth';
import { CadenaBusqueda, crearCadena, darDeBajaCadena } from './utils/busqueda';
import { ADMIN, AppCatalogo, codigos, crearAppCatalogo, enDias } from './utils/catalogo';
import { erroresContraContrato } from './utils/contrato';
import { LimitesReiniciables } from './utils/limites';
import { cancelarReservasDe } from './utils/postventa';
import { RelojDePrueba } from './utils/reloj';
import { Receptor } from './utils/receptor-webhook';
import {
  buscarYRetener,
  con,
  cuerpoReserva,
  nuevoCliente,
  pasajero,
  referenciaPago,
  reservar,
} from './utils/reserva';

const WEBHOOKS = '/flights/v1/webhooks';
const SECRETO = 'secreto-de-prueba-para-firmar-01';
const TODOS = [
  'booking.confirmed',
  'booking.failed',
  'booking.changed',
  'booking.cancelled',
  'booking.baggage_added',
  'hold.expired',
  'flight.schedule_changed',
  'flight.cancelled',
  'booking.ticket_issuing',
  'booking.ticket_issued',
  'booking.ticket_failed',
  'booking.checked_in',
];

type Cliente = { id: string; token: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- cuerpos que se validan contra el contrato
type Json = Record<string, any>;

/** El HTTP de las pruebas: cada prueba decide qué contesta y qué se le pidió. */
class ClienteControlable extends ClienteWebhook {
  llamadas: PeticionWebhook[] = [];
  modo: (peticion: PeticionWebhook) => Promise<ResultadoWebhook> = () => Promise.resolve(ok());

  enviar(peticion: PeticionWebhook): Promise<ResultadoWebhook> {
    this.llamadas.push(peticion);
    return this.modo(peticion);
  }

  de(url: string): PeticionWebhook[] {
    return this.llamadas.filter((l) => l.url === url);
  }
}

const ok = (codigoHttp = 200): ResultadoWebhook => ({ codigoHttp, error: null });
const falla = (codigoHttp: number | null, error: string | null = null): ResultadoWebhook => ({
  codigoHttp,
  error,
});

describe('Entrega de webhooks', () => {
  const reloj = new RelojDePrueba();
  const limites = new LimitesReiniciables();
  const cliente = new ClienteControlable();
  let c: AppCatalogo;
  let prisma: PrismaService;
  let k: CadenaBusqueda;
  let entrega: EntregaWebhooks;
  let real: ClienteWebhookHttp;
  let receptor: Receptor;
  const clientes: Cliente[] = [];

  const nuevo = async (): Promise<Cliente> => {
    const creado = await nuevoCliente(c.app);
    clientes.push(creado);
    return creado;
  };
  const suscribir = async (
    dueno: Cliente,
    eventos: string[],
    url: string,
    secret = SECRETO,
  ): Promise<string> =>
    (
      await con(c.app, dueno.token)('post', WEBHOOKS)
        .send({ url, events: eventos, secret })
        .expect(201)
    ).body.id;
  const entregasDe = (webhookId: string) =>
    prisma.db.webhook_entrega.findMany({
      where: { webhook_id: webhookId },
      include: { tipo_evento: { select: { codigo: true } } },
      orderBy: { id: 'asc' },
    });
  const unaEntrega = async (webhookId: string) => (await entregasDe(webhookId))[0];
  const retener = (dueno: Cliente) =>
    buscarYRetener(c.app, dueno.token, [[k.origen, k.destino, k.fecha]], { adults: 1 });
  const reservarCadena = async (dueno: Cliente): Promise<Json> => {
    const retenido = await retener(dueno);
    return (
      await reservar(
        c.app,
        dueno.token,
        cuerpoReserva(retenido.holdId, [pasajero('ADULT', 1)], referenciaPago()),
      ).expect(201)
    ).body;
  };
  /** Filas PENDIENTE/ENTREGADO/FALLIDO puestas a mano, para probar la entrega sin una reserva. */
  const insertarEntregas = async (
    webhookId: string,
    cantidad: number,
    opciones: {
      estado?: 'PENDIENTE' | 'ENTREGADO' | 'FALLIDO';
      intentos?: number;
      proximo?: Date;
      actualizada?: Date;
    } = {},
  ): Promise<string[]> => {
    const { estado = 'PENDIENTE', intentos = 0, proximo = reloj.ahora() } = opciones;
    const actualizada = opciones.actualizada ?? proximo;
    const codigo = estado === 'ENTREGADO' ? 200 : null;
    const filas = await prisma.db.$queryRaw<Array<{ eventId: string }>>`
      WITH nuevos AS (SELECT gen_random_uuid() AS id FROM generate_series(1, ${cantidad}))
      INSERT INTO vuelos.webhook_entrega
             (webhook_id, id_evento, tipo_evento_id, payload, estado, intentos, proximo_intento,
              ultimo_codigo_http, fecha_creacion, fecha_actualizacion)
      SELECT ${webhookId}::uuid, n.id, t.id,
             jsonb_build_object('eventId', n.id::text, 'eventType', 'booking.confirmed',
                                'occurredAt', '2026-01-01T00:00:00.000Z', 'apiVersion', '1.5.0',
                                'data', jsonb_build_object('bookingId', gen_random_uuid()::text,
                                                           'pnr', 'ABC234', 'status', 'CONFIRMED')),
             ${estado}::vuelos.estado_entrega_webhook, ${intentos}::smallint, ${proximo}::timestamptz,
             ${codigo}::smallint, ${actualizada}::timestamptz, ${actualizada}::timestamptz
        FROM nuevos n JOIN vuelos.tipo_evento t ON t.codigo = 'booking.confirmed'
      RETURNING id_evento::text AS "eventId"`;
    return filas.map((f) => f.eventId);
  };
  const minutos = (n: number) => n * 60_000;

  beforeAll(async () => {
    c = await crearAppCatalogo({
      reloj,
      limites,
      reemplazos: [{ proveedor: ClienteWebhook, valor: cliente }],
    });
    prisma = c.prisma;
    real = new ClienteWebhookHttp(c.app.get(ConfigService));
    entrega = c.app.get(EntregaWebhooks);
    receptor = new Receptor();
    await receptor.iniciar();
    k = await crearCadena(c);
    await c
      .admin('patch', `${ADMIN}/airlines/${k.aerolinea}`, {
        ticketPrefix: await codigos.prefijoBoleto(prisma),
      })
      .expect(200);
    await c
      .admin('patch', `${ADMIN}/departures/${k.salida}`, {
        cabins: [{ cabinClass: 'ECONOMY', totalSeats: 6 }],
      })
      .expect(200);
  });
  beforeEach(() => {
    reloj.alPresente();
    limites.reiniciar();
    cliente.llamadas = [];
    cliente.modo = () => Promise.resolve(ok());
    receptor.recibidos = [];
    receptor.codigo = 200;
  });
  afterAll(async () => {
    // Sin suscripciones, lo que quede pendiente se cierra (FALLIDO, SUBSCRIPTION_INACTIVE)
    for (const dueno of clientes) {
      const lista = await con(c.app, dueno.token)('get', WEBHOOKS);
      for (const w of (lista.body as Json[]) ?? []) {
        await con(c.app, dueno.token)('delete', `${WEBHOOKS}/${w.id}`);
      }
      await cancelarReservasDe(c.app, dueno.token);
    }
    reloj.adelantar(60 * 24);
    await entrega.ejecutar();
    await darDeBajaCadena(c, k);
    await receptor.detener();
    await desactivarUsuariosDePrueba(c.app);
    await c.cerrar();
  });

  describe('del hecho de negocio a la entrega', () => {
    let a: Cliente;
    let b: Cliente;
    let subA: string;
    let subB: string;
    let reserva: Json;
    const rutaA = `/a/${randomUUID()}`;

    beforeAll(async () => {
      a = await nuevo();
      b = await nuevo();
      subA = await suscribir(
        a,
        [
          'booking.confirmed',
          'booking.ticket_issued',
          'booking.cancelled',
          'flight.schedule_changed',
        ],
        receptor.url(rutaA),
      );
      subB = await suscribir(
        b,
        TODOS,
        receptor.url(`/b/${randomUUID()}`),
        'otro-secreto-de-pruebas-02',
      );
      cliente.llamadas = [];
      reserva = await reservarCadena(a);
    });

    it('confirmar la reserva deja una entrega PENDIENTE por evento suscrito, y solo del dueño', async () => {
      expect(reserva.status).toBe('CONFIRMED');
      const filas = await entregasDe(subA);
      expect(filas.map((f) => f.tipo_evento.codigo).sort()).toEqual([
        'booking.confirmed',
        'booking.ticket_issued',
      ]);
      expect(filas.every((f) => f.estado === 'PENDIENTE' && f.intentos === 0)).toBe(true);
      // booking.ticket_issuing no estaba suscrito; la suscripción de otro usuario no recibe nada
      expect(await entregasDe(subB)).toEqual([]);
    });

    it('la reserva no hizo ninguna llamada HTTP: el envío es del proceso aparte', () => {
      expect(cliente.llamadas).toEqual([]);
      expect(receptor.de(rutaA)).toEqual([]);
    });

    it('el payload guardado cumple WebhookPayload y no lleva datos del pasajero', async () => {
      for (const fila of await entregasDe(subA)) {
        const payload = fila.payload as Json;
        expect(erroresContraContrato('WebhookPayload', payload)).toEqual([]);
        expect(payload).toMatchObject({
          eventId: fila.id_evento,
          eventType: fila.tipo_evento.codigo,
          apiVersion: '1.5.0',
          // el estado de la reserva en el momento del evento: al emitir el boleto aún se emite
          data: {
            bookingId: reserva.bookingId,
            pnr: reserva.pnr,
            status:
              fila.tipo_evento.codigo === 'booking.confirmed' ? 'CONFIRMED' : 'TICKET_ISSUING',
          },
        });
        expect(payload.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(Object.keys(payload.data).sort()).toEqual(['bookingId', 'pnr', 'status']);
        expect(JSON.stringify(payload)).not.toMatch(/ADU1|@e2e|1710034065/);
      }
    });

    it('al enviar: POST firmado con HMAC-SHA256 de "timestamp.cuerpo", y la entrega queda ENTREGADO', async () => {
      cliente.modo = (p) => real.enviar(p);
      const antes = reloj.ahora();
      await entrega.ejecutar();
      const recibidos = receptor.de(rutaA);
      expect(recibidos).toHaveLength(2);
      for (const r of recibidos) {
        const payload = JSON.parse(r.cuerpo) as Json;
        expect(r.cabeceras['content-type']).toBe('application/json');
        expect(r.cabeceras['x-webhook-event']).toBe(payload.eventType);
        expect(r.cabeceras['x-webhook-id']).toBe(payload.eventId);
        const marca = Number(r.cabeceras['x-webhook-timestamp']);
        expect(marca).toBe(Math.floor(antes.getTime() / 1000));
        const firma = String(r.cabeceras['x-webhook-signature']);
        expect(firma).toMatch(/^sha256=[0-9a-f]{64}$/);
        expect(firmaValida(SECRETO, marca, r.cuerpo, firma)).toBe(true);
        // ni otro secreto, ni otro timestamp, ni otro cuerpo
        expect(firmaValida('otro-secreto-de-pruebas-02', marca, r.cuerpo, firma)).toBe(false);
        expect(firmaValida(SECRETO, marca + 1, r.cuerpo, firma)).toBe(false);
        expect(firmaValida(SECRETO, marca, `${r.cuerpo} `, firma)).toBe(false);
        expect(erroresContraContrato('WebhookPayload', payload)).toEqual([]);
        expect(r.cabeceras['user-agent']).toBeUndefined();
      }
      const filas = await entregasDe(subA);
      expect(filas.every((f) => f.estado === 'ENTREGADO' && f.intentos === 1)).toBe(true);
      expect(filas.every((f) => f.ultimo_codigo_http === 200 && f.ultimo_error === null)).toBe(
        true,
      );
      // Otra corrida no vuelve a enviar lo ya entregado
      await entrega.ejecutar();
      expect(receptor.de(rutaA)).toHaveLength(2);
    });

    it('un cambio de horario de la salida avisa (flight.schedule_changed) al dueño de la reserva viva', async () => {
      const salida = new Date(enDias(20, 15));
      await c
        .admin('patch', `${ADMIN}/departures/${k.salida}`, {
          status: 'DELAYED',
          estimatedDeparture: new Date(salida.getTime() + minutos(40)).toISOString(),
        })
        .expect(200);
      const filas = (await entregasDe(subA)).filter(
        (f) => f.tipo_evento.codigo === 'flight.schedule_changed',
      );
      expect(filas).toHaveLength(1);
      expect(filas[0].payload).toMatchObject({
        eventType: 'flight.schedule_changed',
        data: {
          bookingId: reserva.bookingId,
          pnr: reserva.pnr,
          status: 'CONFIRMED',
          flightNumber: k.vuelo,
          segmentId: k.salida,
        },
      });
      expect(erroresContraContrato('WebhookPayload', filas[0].payload)).toEqual([]);
      expect(await entregasDe(subB)).toEqual([]);
      // Un PATCH que no mueve ningún horario no avisa
      await c
        .admin('patch', `${ADMIN}/departures/${k.salida}`, { departureTerminal: 'T1' })
        .expect(200);
      expect(
        (await entregasDe(subA)).filter((f) => f.tipo_evento.codigo === 'flight.schedule_changed'),
      ).toHaveLength(1);
    });

    it('flight.cancelled llega a quienes tienen una reserva viva en la salida (el catálogo no deja cancelar una con reservas, se publica directo)', async () => {
      const sub = await suscribir(a, ['flight.cancelled'], receptor.url(`/fc/${randomUUID()}`));
      await prisma.transaccionAuditada((tx) =>
        c.app.get(PublicadorEventos).deVuelo(tx, k.salida, 'flight.cancelled', reloj.ahora()),
      );
      const filas = await entregasDe(sub);
      expect(filas).toHaveLength(1);
      expect(filas[0].payload).toMatchObject({
        eventType: 'flight.cancelled',
        data: { bookingId: reserva.bookingId, pnr: reserva.pnr, segmentId: k.salida },
      });
      expect(erroresContraContrato('WebhookPayload', filas[0].payload)).toEqual([]);
      // Se retira para que no estorbe a lo que sigue
      await con(c.app, a.token)('delete', `${WEBHOOKS}/${sub}`).expect(204);
    });

    it('cancelar la reserva avisa con el reembolso como texto decimal', async () => {
      cliente.modo = (p) => real.enviar(p);
      expect(await cancelarReservasDe(c.app, a.token)).toBe(1);
      const cancelada = (await entregasDe(subA)).filter(
        (f) => f.tipo_evento.codigo === 'booking.cancelled',
      );
      expect(cancelada).toHaveLength(1);
      const payload = cancelada[0].payload as Json;
      expect(erroresContraContrato('WebhookPayload', payload)).toEqual([]);
      expect(payload.data).toMatchObject({ status: 'CANCELLED', bookingId: reserva.bookingId });
      expect(payload.data.refundAmount).toMatch(/^\d+\.\d{2}$/);
      await entrega.ejecutar();
      const recibidos = receptor
        .de(rutaA)
        .map((r) => JSON.parse(r.cuerpo) as Json)
        .filter((p) => p.eventType === 'booking.cancelled');
      expect(recibidos).toHaveLength(1);
      expect(recibidos[0].data.refundAmount).toBe(payload.data.refundAmount);
    });
  });

  describe('hold.expired', () => {
    it('al vencer un hold, su dueño recibe el aviso; el de otro usuario no', async () => {
      const dueno = await nuevo();
      const otro = await nuevo();
      const ruta = `/h/${randomUUID()}`;
      const sub = await suscribir(dueno, ['hold.expired'], receptor.url(ruta));
      const subOtro = await suscribir(otro, ['hold.expired'], receptor.url(`/h2/${randomUUID()}`));
      const retenido = await retener(dueno);
      reloj.adelantar(16);
      await c.app.get(VencimientoRetenciones).ejecutar();
      const filas = await entregasDe(sub);
      expect(filas).toHaveLength(1);
      expect(filas[0].payload).toMatchObject({
        eventType: 'hold.expired',
        apiVersion: '1.5.0',
        data: { holdId: retenido.holdId, status: 'EXPIRED' },
      });
      expect(erroresContraContrato('WebhookPayload', filas[0].payload)).toEqual([]);
      expect(await entregasDe(subOtro)).toEqual([]);
      // El vencimiento por el proceso periódico y el perezoso no duplican el aviso
      await c.app.get(VencimientoRetenciones).ejecutar();
      expect(await entregasDe(sub)).toHaveLength(1);
      cliente.modo = (p) => real.enviar(p);
      await entrega.ejecutar();
      expect(receptor.de(ruta)).toHaveLength(1);
    });
  });

  describe('si el receptor está caído la reserva igual se confirma', () => {
    it('201 CONFIRMED, entrega PENDIENTE, y al enviar el fallo se anota y se agenda el reintento', async () => {
      const dueno = await nuevo();
      // Un puerto que acaba de cerrarse: nadie escucha
      const cerrado = new Receptor();
      await cerrado.iniciar();
      const url = cerrado.url(`/caido/${randomUUID()}`);
      await cerrado.detener();
      const sub = await suscribir(dueno, ['booking.confirmed'], url);
      cliente.modo = (p) => real.enviar(p);

      const reserva = await reservarCadena(dueno);
      expect(reserva.status).toBe('CONFIRMED');
      expect(cliente.de(url)).toEqual([]);
      const detalle = await con(c.app, dueno.token)(
        'get',
        `/flights/v1/bookings/${reserva.bookingId}`,
      );
      expect(detalle.body.status).toBe('CONFIRMED');
      expect((await unaEntrega(sub)).estado).toBe('PENDIENTE');

      const inicio = reloj.ahora();
      await entrega.ejecutar();
      const fila = await unaEntrega(sub);
      expect(fila).toMatchObject({
        estado: 'PENDIENTE',
        intentos: 1,
        ultimo_codigo_http: null,
        ultimo_error: 'ECONNREFUSED',
      });
      expect(fila.proximo_intento.getTime()).toBe(inicio.getTime() + minutos(1));
      // Ni la URL ni el puerto quedan en el error guardado
      expect(fila.ultimo_error).not.toContain('127.0.0.1');
    });
  });

  describe('reintentos con espera creciente', () => {
    let dueno: Cliente;
    beforeAll(async () => {
      dueno = await nuevo();
    });
    const nueva = async () => {
      const url = receptor.url(`/r/${randomUUID()}`);
      const sub = await suscribir(dueno, ['booking.confirmed'], url);
      return { sub, url };
    };

    it('1 min, 5 min, 30 min, 2 h y al quinto intento fallido queda FALLIDO', async () => {
      const { sub, url } = await nueva();
      const [eventId] = await insertarEntregas(sub, 1);
      cliente.modo = () => Promise.resolve(falla(500));
      const esperas = [1, 5, 30, 120];
      for (let intento = 1; intento <= 5; intento++) {
        const inicio = reloj.ahora();
        await entrega.ejecutar();
        const fila = await unaEntrega(sub);
        expect(cliente.de(url)).toHaveLength(intento);
        expect(fila.intentos).toBe(intento);
        expect(fila).toMatchObject({ ultimo_codigo_http: 500, ultimo_error: 'HTTP_500' });
        if (intento < 5) {
          expect(fila.estado).toBe('PENDIENTE');
          expect(fila.proximo_intento.getTime()).toBe(
            inicio.getTime() + minutos(esperas[intento - 1]),
          );
          // Antes de la hora no se vuelve a intentar
          reloj.adelantar(esperas[intento - 1] - 0.5);
          await entrega.ejecutar();
          expect(cliente.de(url)).toHaveLength(intento);
          reloj.adelantar(0.5);
        } else {
          expect(fila.estado).toBe('FALLIDO');
        }
      }
      // FALLIDO es definitivo: ni adelantando un día se vuelve a enviar
      reloj.adelantar(60 * 24);
      await entrega.ejecutar();
      expect(cliente.de(url)).toHaveLength(5);
      // Los cinco envíos llevaron el mismo cuerpo y el mismo eventId (para que el receptor deduplique)
      const cuerpos = new Set(cliente.de(url).map((l) => l.cuerpo));
      expect(cuerpos.size).toBe(1);
      expect(new Set(cliente.de(url).map((l) => l.cabeceras['X-Webhook-Id']))).toEqual(
        new Set([eventId]),
      );
      // ...pero cada uno con su timestamp y su firma
      const marcas = cliente.de(url).map((l) => Number(l.cabeceras['X-Webhook-Timestamp']));
      expect(new Set(marcas).size).toBe(5);
    });

    it('si a la tercera responde 2xx, queda ENTREGADO con 3 intentos y sin error', async () => {
      const { sub, url } = await nueva();
      await insertarEntregas(sub, 1);
      const respuestas = [falla(503), falla(null, 'ECONNRESET'), ok(204)];
      cliente.modo = () => Promise.resolve(respuestas.shift() as ResultadoWebhook);
      await entrega.ejecutar();
      expect(await unaEntrega(sub)).toMatchObject({
        estado: 'PENDIENTE',
        ultimo_error: 'HTTP_503',
      });
      reloj.adelantar(1);
      await entrega.ejecutar();
      expect(await unaEntrega(sub)).toMatchObject({
        estado: 'PENDIENTE',
        ultimo_codigo_http: null,
        ultimo_error: 'ECONNRESET',
      });
      reloj.adelantar(5);
      await entrega.ejecutar();
      expect(await unaEntrega(sub)).toMatchObject({
        estado: 'ENTREGADO',
        intentos: 3,
        ultimo_codigo_http: 204,
        ultimo_error: null,
      });
      expect(cliente.de(url)).toHaveLength(3);
    });

    it('una redirección (3xx) o un 4xx cuentan como fallo, no como entregado', async () => {
      const { sub } = await nueva();
      await insertarEntregas(sub, 2);
      cliente.modo = () => Promise.resolve(falla(302));
      await entrega.ejecutar();
      const filas = await entregasDe(sub);
      expect(filas.map((f) => [f.estado, f.ultimo_error])).toEqual([
        ['PENDIENTE', 'HTTP_302'],
        ['PENDIENTE', 'HTTP_302'],
      ]);
    });

    it('un secreto que ya no se puede descifrar es un fallo con código, sin tirar la corrida', async () => {
      const { sub } = await nueva();
      await prisma.db.$executeRaw`
        UPDATE vuelos.webhook_cabecera SET secreto = 'v1.AAAA' WHERE id = ${sub}::uuid`;
      await insertarEntregas(sub, 1);
      await entrega.ejecutar();
      expect(await unaEntrega(sub)).toMatchObject({
        estado: 'PENDIENTE',
        ultimo_error: 'SECRET_UNREADABLE',
      });
    });

    it('una suscripción dada de baja ya no recibe: sus pendientes se cierran sin enviar', async () => {
      const { sub, url } = await nueva();
      await insertarEntregas(sub, 3);
      await con(c.app, dueno.token)('delete', `${WEBHOOKS}/${sub}`).expect(204);
      await entrega.ejecutar();
      expect(cliente.de(url)).toEqual([]);
      const filas = await entregasDe(sub);
      expect(filas.map((f) => [f.estado, f.ultimo_error])).toEqual(
        Array(3).fill(['FALLIDO', 'SUBSCRIPTION_INACTIVE']),
      );
    });

    it('un evento nuevo no se encola para una suscripción dada de baja', async () => {
      const otro = await nuevo();
      const url = receptor.url(`/baja/${randomUUID()}`);
      const sub = await suscribir(otro, ['hold.expired'], url);
      await con(c.app, otro.token)('delete', `${WEBHOOKS}/${sub}`).expect(204);
      await retener(otro);
      reloj.adelantar(16);
      await c.app.get(VencimientoRetenciones).ejecutar();
      expect(await entregasDe(sub)).toEqual([]);
    });

    it('un envío que tarda no deja pasar a otra corrida del mismo proceso (una a la vez)', async () => {
      const { sub, url } = await nueva();
      await insertarEntregas(sub, 1);
      const soltar = () => pendientes.forEach((liberar) => liberar());
      const pendientes: Array<() => void> = [];
      cliente.modo = () =>
        new Promise((resolver) => {
          pendientes.push(() => resolver(ok()));
        });
      const primera = entrega.ejecutar();
      const segunda = entrega.ejecutar();
      expect(segunda).toBe(primera);
      await new Promise((r) => setTimeout(r, 200));
      soltar();
      await primera;
      expect(cliente.de(url)).toHaveLength(1);
    });

    it('si el proceso muere a mitad de un envío, la entrega vuelve sola al vencer el arrendamiento', async () => {
      const { sub, url } = await nueva();
      await insertarEntregas(sub, 1);
      const tomadas = await c.app
        .get(EntregaRepository)
        .reclamar(reloj.ahora(), 50, REGLAS_ENTREGA.arrendamientoSegundos);
      expect(tomadas.filter((t) => t.webhookId === sub)).toHaveLength(1);
      // Mientras dura el arrendamiento nadie más la toma
      await entrega.ejecutar();
      expect(cliente.de(url)).toEqual([]);
      reloj.adelantar(REGLAS_ENTREGA.arrendamientoSegundos / 60 + 0.1);
      await entrega.ejecutar();
      expect(cliente.de(url)).toHaveLength(1);
      expect(await unaEntrega(sub)).toMatchObject({ estado: 'ENTREGADO', intentos: 2 });
    });

    it('los resultados atrasados de un intento viejo no pisan al nuevo', async () => {
      const { sub } = await nueva();
      await insertarEntregas(sub, 1);
      const repositorio = c.app.get(EntregaRepository);
      const [primera] = (await repositorio.reclamar(reloj.ahora(), 50, 60)).filter(
        (t) => t.webhookId === sub,
      );
      reloj.adelantar(2);
      const [segunda] = (await repositorio.reclamar(reloj.ahora(), 50, 60)).filter(
        (t) => t.webhookId === sub,
      );
      expect([primera.intentos, segunda.intentos]).toEqual([1, 2]);
      expect(
        await repositorio.registrarResultado(primera.id, 1, reloj.ahora(), ok(), null),
      ).toBeNull();
      expect(await repositorio.registrarResultado(segunda.id, 2, reloj.ahora(), ok(), null)).toBe(
        'ENTREGADO',
      );
      expect(await unaEntrega(sub)).toMatchObject({ estado: 'ENTREGADO', intentos: 2 });
    });
  });

  describe('una suscripción que solo falla se da de baja', () => {
    it('10 entregas FALLIDO seguidas la desactivan (con auditoría) y las 9 anteriores no', async () => {
      const dueno = await nuevo();
      const sub = await suscribir(dueno, ['booking.confirmed'], receptor.url(`/d/${randomUUID()}`));
      const ultimoIntento = REGLAS_ENTREGA.maximoIntentos - 1;
      // Una entregada hace una hora corta la racha
      await insertarEntregas(sub, 1, {
        estado: 'ENTREGADO',
        intentos: 1,
        actualizada: new Date(reloj.ahora().getTime() - minutos(60)),
      });
      await insertarEntregas(sub, 9, { intentos: ultimoIntento });
      cliente.modo = () => Promise.resolve(falla(500));
      await entrega.ejecutar();
      expect((await entregasDe(sub)).filter((f) => f.estado === 'FALLIDO')).toHaveLength(9);
      const activa = async () =>
        (await prisma.db.webhook_cabecera.findUniqueOrThrow({ where: { id: sub } })).activo;
      // 9 FALLIDO + 1 ENTREGADO entre las últimas 10: sigue activa
      expect(await activa()).toBe(true);
      await insertarEntregas(sub, 1, { intentos: ultimoIntento });
      await entrega.ejecutar();
      expect(await activa()).toBe(false);
      const lista = await con(c.app, dueno.token)('get', WEBHOOKS).expect(200);
      expect(lista.body).toEqual([]);
      const auditoria = await prisma.db.auditoria.findMany({
        where: { nombre_tabla: 'webhook_cabecera', id_registro: sub, operacion: 'ACTUALIZACION' },
      });
      expect(auditoria).toHaveLength(1);
      expect(auditoria[0]).toMatchObject({ id_usuario: null, datos_nuevos: { activo: false } });
    });
  });

  describe('SSRF también al entregar', () => {
    it('una suscripción que apunta a la metadata de la nube no recibe nada, aunque esté en la base', async () => {
      const dueno = await nuevo();
      const sub = await suscribir(dueno, ['booking.confirmed'], receptor.url('/x'));
      await prisma.db.$executeRaw`
        UPDATE vuelos.webhook_cabecera SET url = 'http://169.254.169.254/latest/meta-data'
         WHERE id = ${sub}::uuid`;
      await insertarEntregas(sub, 1);
      cliente.modo = (p) => real.enviar(p);
      await entrega.ejecutar();
      expect(await unaEntrega(sub)).toMatchObject({
        estado: 'PENDIENTE',
        ultimo_codigo_http: null,
        ultimo_error: 'DESTINATION_NOT_ALLOWED',
      });
    });
  });

  describe('dos procesos a la vez', () => {
    it('reclamar a la vez nunca da la misma entrega a los dos', async () => {
      const dueno = await nuevo();
      const sub = await suscribir(dueno, ['booking.confirmed'], receptor.url(`/p/${randomUUID()}`));
      await insertarEntregas(sub, 30);
      const repositorio = c.app.get(EntregaRepository);
      const ahora = reloj.ahora();
      const tandas = await Promise.all(
        Array.from({ length: 4 }, () => repositorio.reclamar(ahora, 12, 120)),
      );
      const ids = tandas
        .flat()
        .filter((t) => t.webhookId === sub)
        .map((t) => String(t.id));
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length).toBeLessThanOrEqual(30);
      expect(tandas.flat().every((t) => t.intentos === 1)).toBe(true);
    });

    it('dos instancias del proceso entregan cada evento exactamente una vez', async () => {
      const dueno = await nuevo();
      const ruta = `/conc/${randomUUID()}`;
      const sub = await suscribir(dueno, ['booking.confirmed'], receptor.url(ruta));
      const ids = await insertarEntregas(sub, 60);
      cliente.modo = async (p) => {
        // un poco de latencia para que las dos instancias de verdad se crucen
        await new Promise((r) => setTimeout(r, 5));
        return real.enviar(p);
      };
      const otra = new EntregaWebhooks(
        c.app.get(EntregaRepository),
        cliente,
        c.app.get(CifradoSecreto),
        reloj,
        c.app.get(ConfigService),
      );
      await Promise.all([entrega.ejecutar(), otra.ejecutar()]);

      const recibidos = receptor.de(ruta).map((r) => (JSON.parse(r.cuerpo) as Json).eventId);
      expect(recibidos).toHaveLength(60);
      expect([...recibidos].sort()).toEqual([...ids].sort());
      const filas = await entregasDe(sub);
      expect(filas.every((f) => f.estado === 'ENTREGADO' && f.intentos === 1)).toBe(true);
    });
  });

  describe('lo que se registra', () => {
    it('cada intento deja una línea sin URL, secreto, cuerpo ni datos del pasajero', async () => {
      const dueno = await nuevo();
      const url = receptor.url(`/log/${randomUUID()}?token=tokendeprueba`);
      const sub = await suscribir(dueno, ['booking.confirmed'], url, 'secreto-que-no-debe-salir-1');
      const reserva = await reservarCadena(dueno);
      const lineas: string[] = [];
      const espiar = (nivel: 'log' | 'warn' | 'error') =>
        jest
          .spyOn(Logger.prototype, nivel)
          .mockImplementation((...partes: unknown[]) => void lineas.push(partes.join(' ')));
      const espias = [espiar('log'), espiar('warn'), espiar('error')];
      try {
        receptor.codigo = 500;
        cliente.modo = (p) => real.enviar(p);
        await entrega.ejecutar();
        receptor.codigo = 200;
        reloj.adelantar(1);
        await entrega.ejecutar();
      } finally {
        espias.forEach((e) => e.mockRestore());
      }
      const mias = lineas.filter((l) => l.includes('Entrega'));
      expect(mias.length).toBeGreaterThanOrEqual(2);
      const texto = mias.join('\n');
      expect(texto).toMatch(/Entrega \d+ \(booking\.confirmed\) intento 1\/5: PENDIENTE 500/);
      expect(texto).toMatch(/intento 2\/5: ENTREGADO 200/);
      for (const prohibido of [
        'secreto-que-no-debe-salir-1',
        'tokendeprueba',
        '127.0.0.1',
        reserva.pnr,
        reserva.bookingId,
        'sha256=',
        sub,
      ]) {
        expect(texto).not.toContain(prohibido);
      }
    });
  });
});
