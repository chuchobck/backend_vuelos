import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Observabilidad } from '../src/observabilidad/observabilidad';
import { EntregaWebhooks } from '../src/modules/vuelos/operaciones/webhook/entrega-webhooks';
import type { CadenaBusqueda } from './utils/busqueda';
import type { AppCatalogo } from './utils/catalogo';
import { puertoLibre } from './utils/grpc';
import { LimitesReiniciables } from './utils/limites';
import { RecolectorOtlp } from './utils/recolector-otlp';
import { Receptor } from './utils/receptor-webhook';
import { RelojDePrueba } from './utils/reloj';

/**
 * WEBHOOKS_MODE=local: el core entrega él mismo los webhooks a los terceros. La traza interna de
 * Quinde no se les revela: la entrega a un tercero NUNCA lleva traceparent ni tracestate
 * (docs/OBSERVABILIDAD.md, sección 2, "Propagación"), aunque la reserva que la originó venga
 * dentro de una traza.
 */

const reloj = new RelojDePrueba();
const limites = new LimitesReiniciables();
const entornoAnterior: Record<string, string | undefined> = {};
let recolector: RecolectorOtlp;
let puertoMetricas: number;

beforeAll(async () => {
  recolector = await new RecolectorOtlp().iniciar();
  puertoMetricas = await puertoLibre();
  const entorno = {
    WEBHOOKS_MODE: 'local',
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
  await recolector.detener();
  for (const [nombre, valor] of Object.entries(entornoAnterior)) {
    if (valor === undefined) delete process.env[nombre];
    else process.env[nombre] = valor;
  }
});

describe('Observabilidad en WEBHOOKS_MODE=local', () => {
  let c: AppCatalogo;
  let app: INestApplication;
  let k: CadenaBusqueda;
  let entrega: EntregaWebhooks;
  let receptor: Receptor;
  let utilidades: typeof import('./utils/reserva') &
    typeof import('./utils/busqueda') &
    typeof import('./utils/catalogo') &
    typeof import('./utils/postventa') &
    typeof import('./utils/auth');
  let dueno: { id: string; token: string };

  const forzarEnvio = () =>
    (
      app.get(Observabilidad).trazas as unknown as { proveedor: { forceFlush(): Promise<void> } }
    ).proveedor.forceFlush();

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
    entrega = app.get(EntregaWebhooks);
    receptor = new Receptor();
    await receptor.iniciar();
    k = await busqueda.crearCadena(c);
    await c
      .admin('patch', `${catalogo.ADMIN}/airlines/${k.aerolinea}`, {
        ticketPrefix: await catalogo.codigos.prefijoBoleto(c.prisma),
      })
      .expect(200);
    await c
      .admin('patch', `${catalogo.ADMIN}/departures/${k.salida}`, {
        cabins: [{ cabinClass: 'ECONOMY', totalSeats: 6 }],
      })
      .expect(200);
    dueno = await utilidades.nuevoCliente(app);
  });

  afterAll(async () => {
    reloj.alPresente();
    await utilidades.cancelarReservasDe(app, dueno.token);
    // Lo pendiente de este dueño sale al receptor y nadie más lo ve
    reloj.adelantar(60 * 72);
    await entrega.ejecutar();
    await receptor.detener();
    await c.admin('patch', `${utilidades.ADMIN}/airlines/${k.aerolinea}`, { ticketPrefix: null });
    await utilidades.darDeBajaCadena(c, k);
    await utilidades.desactivarUsuariosDePrueba(app);
    await c.cerrar();
  });

  it('la entrega a un tercero no lleva traceparent ni tracestate, aunque la reserva venga en una traza', async () => {
    const ruta = `/hook/${randomUUID()}`;
    const suscripcion = await utilidades
      .con(app, dueno.token)('post', '/flights/v1/webhooks')
      .send({
        url: receptor.url(ruta),
        events: ['booking.confirmed', 'booking.ticket_issued'],
        secret: 'secreto-de-prueba-para-firmar-01',
      })
      .expect(201);
    expect(suscripcion.body.id).toBeDefined();

    const traceId = randomUUID().replace(/-/g, '');
    const retenido = await utilidades.buscarYRetener(
      app,
      dueno.token,
      [[k.origen, k.destino, k.fecha]],
      { adults: 1 },
    );
    const reserva = await utilidades
      .reservar(
        app,
        dueno.token,
        utilidades.cuerpoReserva(retenido.holdId, [utilidades.pasajero('ADULT', 1)]),
      )
      .set('traceparent', `00-${traceId}-${'a'.repeat(16)}-01`)
      .expect(201);
    expect(reserva.headers['x-trace-id']).toBe(traceId);

    reloj.alPresente();
    const resultado = await entrega.ejecutar();
    expect(resultado.entregadas).toBeGreaterThanOrEqual(2);

    const recibidos = receptor.de(ruta);
    expect(recibidos.length).toBeGreaterThanOrEqual(2);
    for (const recibido of recibidos) {
      expect(Object.keys(recibido.cabeceras)).not.toContain('traceparent');
      expect(Object.keys(recibido.cabeceras)).not.toContain('tracestate');
      expect(recibido.cuerpo).not.toContain(traceId);
      expect(JSON.stringify(recibido.cabeceras)).not.toContain(traceId);
      // Las cabeceras de siempre sí
      expect(recibido.cabeceras['x-webhook-signature']).toMatch(/^sha256=/);
    }
  });

  it('la bandeja evento_saliente no se usa en modo local: ningún evento, ningún traceparent guardado', async () => {
    const [{ n }] = await c.prisma.db.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM vuelos.evento_saliente
       WHERE id_propietario = ${dueno.id}`;
    expect(n).toBe(0);
  });

  it('la corrida de la entrega es su propia traza raíz y se mide', async () => {
    await entrega.ejecutar();
    let corrida;
    const fin = Date.now() + 8_000;
    do {
      await forzarEnvio();
      corrida = recolector.spans.find((s) => s.nombre === 'job entrega-webhooks');
      if (corrida) break;
      await new Promise((listo) => setTimeout(listo, 30));
    } while (Date.now() < fin);
    expect(corrida).toMatchObject({ tipo: 1, parentSpanId: '', servicio: 'quinde-core' });

    const texto = await (await fetch(`http://127.0.0.1:${puertoMetricas}/metrics`)).text();
    expect(texto).toMatch(/core_job_run_duration_seconds_count\{job="entrega-webhooks"\} [1-9]/);
    // En modo local la bandeja no existe: los gauges de la bandeja tampoco
    expect(texto).not.toContain('core_outbox_pending');
  });
});
