import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { validarEntorno } from '../src/config/entorno';
import { PrismaService } from '../src/prisma/prisma.service';
import { BandejaEventosRepository } from '../src/modules/vuelos/operaciones/webhook/bandeja-eventos.repository';
import {
  PurgaBandeja,
  REGLAS_PURGA,
} from '../src/modules/vuelos/operaciones/webhook/purga-bandeja';
import { RelevoEventos } from '../src/modules/vuelos/operaciones/webhook/relevo-eventos';
import { LogEnMemoria } from './utils/log-en-memoria';
import { IdentityTokenFalso, NotifierFalso } from './utils/notifier-falso';
import { RelojDePrueba } from './utils/reloj';

/**
 * La purga de la bandeja evento_saliente (WEBHOOKS_MODE=notifier): PUBLICADO a los 7 días desde
 * publicado_en, FALLIDO a los 30 desde que falló, PENDIENTE jamás. Las filas son sintéticas y
 * llevan todas el mismo id_propietario (la marca de la suite); se ponen en el pasado respecto del
 * reloj de la prueba, que no se adelanta, para no tocar los eventos recientes de otras suites.
 */

const RAIZ = resolve(__dirname, '..');
const SCRIPT = join(RAIZ, 'scripts', 'purgar-eventos.cjs');
const DIA_MS = 24 * 60 * 60 * 1000;
const PNR = 'PURGA1';

const reloj = new RelojDePrueba();
const log = new LogEnMemoria();
const entornoAnterior: Record<string, string | undefined> = {};
let notifier: NotifierFalso;
let identity: IdentityTokenFalso;

type Estado = 'PENDIENTE' | 'PUBLICADO' | 'FALLIDO';

beforeAll(async () => {
  notifier = await NotifierFalso.crear();
  identity = await IdentityTokenFalso.crear();
  const entorno = {
    WEBHOOKS_MODE: 'notifier',
    NOTIFIER_URL: notifier.url,
    IDENTITY_TOKEN_URL: identity.urlToken,
    NOTIFIER_CLIENT_ID: 'core-vuelos-e2e',
    NOTIFIER_CLIENT_SECRET: 'secreto-del-cliente-core-vuelos-de-prueba-77',
    EVENT_RELAY_JOB_ENABLED: 'false',
    EVENT_OUTBOX_PURGE_JOB_ENABLED: 'false',
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

describe('PurgaBandeja', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bandeja: BandejaEventosRepository;
  let relevo: RelevoEventos;
  let purga: PurgaBandeja;
  let url: string;
  const marca = `purga-e2e-${randomUUID().slice(0, 8)}`;

  /** `cantidad` eventos sintéticos de `edadDias` días de antigüedad respecto del reloj. */
  const sembrar = async (
    estado: Estado,
    cantidad: number,
    edadDias: number,
    arrendamiento?: 'vencido' | 'vigente',
  ): Promise<string[]> => {
    const ahora = reloj.ahora();
    const desde = new Date(ahora.getTime() - edadDias * DIA_MS);
    const lease =
      arrendamiento === 'vigente'
        ? new Date(ahora.getTime() + 3_600_000)
        : arrendamiento === 'vencido'
          ? new Date(desde.getTime() + 60_000)
          : null;
    const publicado = estado === 'PUBLICADO' ? desde : null;
    const codigo = estado === 'FALLIDO' ? 422 : null;
    const error = estado === 'FALLIDO' ? 'HTTP_422' : null;
    const filas = await prisma.db.$queryRaw<Array<{ id: string }>>`
      WITH nuevos AS (SELECT gen_random_uuid() AS id, gen_random_uuid() AS reserva
                        FROM generate_series(1, ${cantidad}))
      INSERT INTO vuelos.evento_saliente
             (id_evento, tipo, id_propietario, sobre, estado, proximo_intento, arrendamiento_hasta,
              reintentar_hasta, ultimo_codigo_http, ultimo_error, creado_en, publicado_en)
      SELECT n.id, 'booking.confirmed', ${marca}::text,
             jsonb_build_object('eventId', n.id::text, 'eventType', 'booking.confirmed',
                                'schemaVersion', '1.0', 'occurredAt', '2026-10-16T14:30:00.000Z',
                                'ownerId', ${marca}::text,
                                'data', jsonb_build_object('bookingId', n.reserva::text, 'pnr', ${PNR}::text,
                                                           'status', 'CONFIRMED'))::text,
             ${estado}::vuelos.estado_evento_saliente, ${desde}::timestamptz, ${lease}::timestamptz,
             ${new Date(desde.getTime() + 48 * 3_600_000)}::timestamptz,
             ${codigo}::smallint, ${error}::text, ${desde}::timestamptz, ${publicado}::timestamptz
        FROM nuevos n
      RETURNING id_evento::text AS id`;
    return filas.map((f) => f.id);
  };

  /** Cuáles de estos eventos siguen en la bandeja. */
  const existen = async (ids: string[]): Promise<Set<string>> => {
    const filas = await prisma.db.$queryRaw<Array<{ id: string }>>`
      SELECT id_evento::text AS id FROM vuelos.evento_saliente WHERE id_evento = ANY(${ids}::uuid[])`;
    return new Set(filas.map((f) => f.id));
  };

  const cuantos = async (estado: Estado): Promise<number> =>
    (
      await prisma.db.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM vuelos.evento_saliente
         WHERE id_propietario = ${marca} AND estado::text = ${estado}`
    )[0].n;

  /** Da de baja lo que quede de la suite (publicado hace 60 días) y deja que la purga lo lleve. */
  const limpiar = async () => {
    const ahora = reloj.ahora();
    await prisma.db.$executeRaw`
      UPDATE vuelos.evento_saliente
         SET estado = 'PUBLICADO', arrendamiento_hasta = NULL, ultimo_codigo_http = NULL,
             ultimo_error = NULL, publicado_en = ${new Date(ahora.getTime() - 60 * DIA_MS)}::timestamptz
       WHERE id_propietario = ${marca}`;
    await purga.ejecutar();
  };

  const correrScript = (
    argumentos: string[],
    extra: Record<string, string> = {},
  ): Promise<{ codigo: number; salida: string }> =>
    new Promise((resolver) => {
      execFile(
        process.execPath,
        [SCRIPT, ...argumentos],
        { cwd: RAIZ, env: { ...process.env, DATABASE_URL: url, ...extra } },
        (error, stdout, stderr) => {
          const codigo = error ? Number((error as { code?: unknown }).code ?? 1) : 0;
          resolver({ codigo, salida: `${stdout}${stderr}` });
        },
      );
    });

  beforeAll(async () => {
    const { crearApp } = await import('./utils/crear-app');
    app = await crearApp([], { reloj });
    app.useLogger(log);
    prisma = app.get(PrismaService);
    bandeja = app.get(BandejaEventosRepository);
    relevo = app.get(RelevoEventos);
    purga = app.get(PurgaBandeja);
    url = app.get(ConfigService).getOrThrow<string>('DATABASE_URL');
    // Empieza sin filas viejas de corridas anteriores: los conteos de abajo son exactos
    await purga.ejecutar();
    log.lineas.length = 0;
  });

  afterAll(async () => {
    reloj.alPresente();
    await limpiar();
    await app.close();
  });

  beforeEach(() => {
    reloj.alPresente();
    notifier.reiniciar();
  });

  afterEach(async () => {
    await limpiar();
  });

  describe('qué borra y qué deja', () => {
    it('borra los PUBLICADO viejos y deja los recientes', async () => {
      const [viejo, justoViejo] = [
        ...(await sembrar('PUBLICADO', 1, 30)),
        ...(await sembrar('PUBLICADO', 1, 7.01)),
      ];
      const [reciente, justoReciente, ayer] = [
        ...(await sembrar('PUBLICADO', 1, 0)),
        ...(await sembrar('PUBLICADO', 1, 6.99)),
        ...(await sembrar('PUBLICADO', 1, 1)),
      ];

      const resultado = await purga.ejecutar();

      expect(resultado).toMatchObject({ publicados: 2, fallidos: 0, hayMas: false });
      const quedan = await existen([viejo, justoViejo, reciente, justoReciente, ayer]);
      expect([...quedan].sort()).toEqual([reciente, justoReciente, ayer].sort());
    });

    it('borra los FALLIDO viejos y deja los recientes (cuentan desde que fallaron)', async () => {
      const [viejo, justoViejo] = [
        ...(await sembrar('FALLIDO', 1, 90)),
        ...(await sembrar('FALLIDO', 1, 30.01)),
      ];
      const [reciente, justoReciente, deHaceUnaSemana] = [
        ...(await sembrar('FALLIDO', 1, 0)),
        ...(await sembrar('FALLIDO', 1, 29.99)),
        // Más viejo que lo que dura un PUBLICADO, pero un FALLIDO dura 30 días
        ...(await sembrar('FALLIDO', 1, 8)),
      ];

      const resultado = await purga.ejecutar();

      expect(resultado).toMatchObject({ publicados: 0, fallidos: 2, hayMas: false });
      const quedan = await existen([viejo, justoViejo, reciente, justoReciente, deHaceUnaSemana]);
      expect([...quedan].sort()).toEqual([reciente, justoReciente, deHaceUnaSemana].sort());
    });

    it('deja TODOS los PENDIENTE, sin importar su edad ni su arrendamiento', async () => {
      const ids = [
        ...(await sembrar('PENDIENTE', 1, 0)),
        ...(await sembrar('PENDIENTE', 1, 8)),
        ...(await sembrar('PENDIENTE', 1, 400)),
        ...(await sembrar('PENDIENTE', 1, 400, 'vencido')),
        ...(await sembrar('PENDIENTE', 1, 400, 'vigente')),
        ...(await sembrar('PENDIENTE', 3, 31, 'vencido')),
      ];

      const resultado = await purga.ejecutar();

      expect(resultado).toMatchObject({ publicados: 0, fallidos: 0 });
      expect((await existen(ids)).size).toBe(ids.length);
      expect(await cuantos('PENDIENTE')).toBe(ids.length);
    });

    it('no borra un viejo con un arrendamiento vigente (otro proceso lo tiene tomado)', async () => {
      const [tomadoPublicado] = await sembrar('PUBLICADO', 1, 30, 'vigente');
      const [tomadoFallido] = await sembrar('FALLIDO', 1, 90, 'vigente');
      const [libre] = await sembrar('PUBLICADO', 1, 30, 'vencido');

      await purga.ejecutar();

      expect([...(await existen([tomadoPublicado, tomadoFallido, libre]))].sort()).toEqual(
        [tomadoPublicado, tomadoFallido].sort(),
      );
    });

    it('usa las retenciones configuradas, contadas con el Reloj', async () => {
      const config = new ConfigService({
        EVENT_OUTBOX_RETENTION_DAYS: 2,
        EVENT_OUTBOX_FAILED_RETENTION_DAYS: 10,
      });
      const propia = new PurgaBandeja(bandeja, reloj, config);
      const [publicado3, publicado1] = [
        ...(await sembrar('PUBLICADO', 1, 3)),
        ...(await sembrar('PUBLICADO', 1, 1)),
      ];
      const [fallido11, fallido9] = [
        ...(await sembrar('FALLIDO', 1, 11)),
        ...(await sembrar('FALLIDO', 1, 9)),
      ];

      expect(await propia.ejecutar()).toMatchObject({ publicados: 1, fallidos: 1 });
      expect([...(await existen([publicado3, publicado1, fallido11, fallido9]))].sort()).toEqual(
        [publicado1, fallido9].sort(),
      );
    });

    it('cuenta los días con el Reloj, no con la hora de la base', async () => {
      // El reloj va 30 días atrás: lo "viejo" y lo "reciente" se miden contra él. Con now() de la
      // base, las dos filas (de 38 y 36 días reales) pasarían de los 7 y se borrarían
      reloj.fijar(new Date(Date.now() - 30 * DIA_MS));
      const [viejo] = await sembrar('PUBLICADO', 1, 8);
      const [reciente] = await sembrar('PUBLICADO', 1, 6);

      expect(await purga.ejecutar()).toMatchObject({ publicados: 1, fallidos: 0 });
      expect([...(await existen([viejo, reciente]))]).toEqual([reciente]);
    });
  });

  describe('lotes y tope por corrida', () => {
    it('borra por sentencias de 1000 como mucho y no pasa del tope de la corrida', async () => {
      const original = { ...REGLAS_PURGA };
      const sentencias: Array<[string, number]> = [];
      const espia = jest.spyOn(bandeja, 'purgarLote').mockImplementation(async (...args) => {
        sentencias.push([args[0], args[3]]);
        return espiado(...args);
      });
      const espiado = BandejaEventosRepository.prototype.purgarLote.bind(bandeja);
      try {
        REGLAS_PURGA.maximoPorCorrida = 2500;
        await sembrar('PUBLICADO', 3500, 30);
        await sembrar('FALLIDO', 200, 90);

        const primera = await purga.ejecutar();

        expect(primera.publicados + primera.fallidos).toBe(2500);
        expect(primera.hayMas).toBe(true);
        expect(await cuantos('PUBLICADO')).toBe(3500 - primera.publicados);
        // Los dos estados avanzan: un PUBLICADO enorme no deja sin purgar al FALLIDO
        expect(primera.fallidos).toBe(200);
        expect(sentencias.every(([, limite]) => limite <= REGLAS_PURGA.lote)).toBe(true);
        expect(Math.max(...sentencias.map(([, limite]) => limite))).toBe(1000);
        // Pedidas: PUB 1000, FALL 1000 (borra 200) | PUB 1000, FALL 300 (nada: se da por vacío) |
        // PUB 300 | y con el cupo agotado ya no pide nada
        expect(sentencias.map(([estado, limite]) => `${estado}:${limite}`)).toEqual([
          'PUBLICADO:1000',
          'FALLIDO:1000',
          'PUBLICADO:1000',
          'FALLIDO:300',
          'PUBLICADO:300',
        ]);

        const segunda = await purga.ejecutar();
        expect(segunda).toMatchObject({ publicados: 1200, fallidos: 0, hayMas: false });
        expect(await cuantos('PUBLICADO')).toBe(0);
        expect(await cuantos('FALLIDO')).toBe(0);
      } finally {
        Object.assign(REGLAS_PURGA, original);
        espia.mockRestore();
      }
    });

    it('un lote de 1000 es el máximo por sentencia con el tope por defecto', async () => {
      expect(REGLAS_PURGA.lote).toBe(1000);
      expect(REGLAS_PURGA.maximoPorCorrida).toBe(20_000);
      const ids = await sembrar('PUBLICADO', 2300, 30);
      const resultado = await purga.ejecutar();
      expect(resultado).toMatchObject({ publicados: 2300, hayMas: false });
      expect((await existen(ids)).size).toBe(0);
    });
  });

  describe('varias instancias y el relevo', () => {
    it('dos instancias a la vez sobre las mismas filas: cada una se borra una sola vez, sin errores', async () => {
      const ids = await sembrar('PUBLICADO', 6000, 30);
      await sembrar('FALLIDO', 1500, 90);
      const a = new PurgaBandeja(bandeja, reloj, app.get(ConfigService));
      const b = new PurgaBandeja(bandeja, reloj, app.get(ConfigService));

      const [ra, rb] = await Promise.all([a.ejecutar(), b.ejecutar()]);

      // Las filas se reparten: la suma es exacta (ni de más ni de menos) y no quedó nada
      expect(ra.publicados + rb.publicados).toBe(6000);
      expect(ra.fallidos + rb.fallidos).toBe(1500);
      expect((await existen(ids)).size).toBe(0);
      expect(log.texto()).not.toContain('Falló la purga');
    });

    it('una fila que otro proceso tiene bloqueada se salta, sin esperar ni borrarla', async () => {
      const [bloqueada, libre] = await sembrar('PUBLICADO', 2, 30);
      const otra = new Client({ connectionString: url });
      await otra.connect();
      try {
        await otra.query('BEGIN');
        await otra.query('SELECT 1 FROM vuelos.evento_saliente WHERE id_evento = $1 FOR UPDATE', [
          bloqueada,
        ]);
        const resultado = await Promise.race([
          purga.ejecutar(),
          new Promise<'esperó'>((listo) => setTimeout(() => listo('esperó'), 3_000)),
        ]);
        expect(resultado).not.toBe('esperó');
        expect([...(await existen([bloqueada, libre]))]).toEqual([bloqueada]);
      } finally {
        await otra.query('ROLLBACK');
        await otra.end();
      }
      // Suelta, la siguiente corrida sí la borra
      await purga.ejecutar();
      expect((await existen([bloqueada])).size).toBe(0);
    });

    it('una fila que el relevo tiene tomada no se borra', async () => {
      const ids = await sembrar('PENDIENTE', 5, 100);
      const tomados = await bandeja.reclamar(reloj.ahora(), 10, 60);
      expect(tomados.map((t) => t.idEvento).sort()).toEqual([...ids].sort());

      await purga.ejecutar();

      expect((await existen(ids)).size).toBe(5);
    });

    it('mientras el relevo publica, la purga no lo rompe ni lo bloquea', async () => {
      const pendientes = await sembrar('PENDIENTE', 30, 100);
      const viejos = await sembrar('PUBLICADO', 3000, 30);
      // Cada publicación tarda: la purga corre en medio del envío, con las filas tomadas
      notifier.porDefecto = () => ({ status: 202, demoraMs: 800 });

      const inicio = Date.now();
      const [r, p] = await Promise.all([relevo.ejecutar(), purga.ejecutar()]);

      expect(r).toMatchObject({ publicados: 30, reintentos: 0, fallidos: 0 });
      expect(p).toMatchObject({ publicados: 3000, fallidos: 0 });
      expect(Date.now() - inicio).toBeLessThan(10_000);
      expect((await existen(viejos)).size).toBe(0);
      // Siguen todos, ahora PUBLICADO con la fecha de hoy: la purga no los alcanza hasta dentro de 7 días
      expect((await existen(pendientes)).size).toBe(30);
      expect(await cuantos('PUBLICADO')).toBe(30);
      expect(notifier.recibidas).toHaveLength(30);
    });
  });

  describe('npm run eventos:purgar', () => {
    it('--dry-run no borra nada y sus conteos son los del borrado real', async () => {
      await sembrar('PUBLICADO', 12, 30);
      await sembrar('PUBLICADO', 4, 2);
      await sembrar('FALLIDO', 5, 60);
      await sembrar('FALLIDO', 3, 10);
      await sembrar('PENDIENTE', 6, 90);
      await sembrar('PENDIENTE', 2, 90, 'vencido');
      const antes = [
        await cuantos('PUBLICADO'),
        await cuantos('FALLIDO'),
        await cuantos('PENDIENTE'),
      ];
      expect(antes).toEqual([16, 8, 8]);

      const simulacro = await correrScript(['--dry-run']);
      expect(simulacro.codigo).toBe(0);
      expect(simulacro.salida).toContain('Borraría: 12 PUBLICADO y 5 FALLIDO.');
      expect(simulacro.salida).toContain('--dry-run: no se borró nada');
      expect([
        await cuantos('PUBLICADO'),
        await cuantos('FALLIDO'),
        await cuantos('PENDIENTE'),
      ]).toEqual(antes);

      const real = await correrScript([]);
      expect(real.codigo).toBe(0);
      expect(real.salida).toContain('Borradas: 12 PUBLICADO y 5 FALLIDO.');
      expect([
        await cuantos('PUBLICADO'),
        await cuantos('FALLIDO'),
        await cuantos('PENDIENTE'),
      ]).toEqual([4, 3, 8]);
    });

    it('purga por tandas de 1000 y deja los PENDIENTE', async () => {
      await sembrar('PUBLICADO', 2600, 30);
      const pendientes = await sembrar('PENDIENTE', 3, 400);
      const real = await correrScript([]);
      expect(real.salida).toContain('Borradas: 2600 PUBLICADO y 0 FALLIDO.');
      expect((await existen(pendientes)).size).toBe(3);
    });

    it('usa las retenciones por defecto del job, acepta las suyas y no imprime datos', async () => {
      const ids = await sembrar('PUBLICADO', 2, 3);
      const porDefecto = await correrScript(['--dry-run']);
      expect(porDefecto.salida).toContain(
        `PUBLICADO más de ${REGLAS_PURGA.retencionPublicadosDias} días`,
      );
      expect(porDefecto.salida).toContain(
        `FALLIDO más de ${REGLAS_PURGA.retencionFallidosDias} días`,
      );
      expect(porDefecto.salida).toContain('Borraría: 0 PUBLICADO');

      const corta = await correrScript(['--dry-run'], { EVENT_OUTBOX_RETENTION_DAYS: '1' });
      expect(corta.salida).toContain('Borraría: 2 PUBLICADO');

      for (const salida of [porDefecto.salida, corta.salida]) {
        for (const id of ids) expect(salida).not.toContain(id);
        expect(salida).not.toContain(marca);
        expect(salida).not.toContain(PNR);
        expect(salida).not.toContain('http');
      }
    });

    it('un argumento o una variable inválidos terminan con 2 y nombran la variable, no su valor', async () => {
      const argumento = await correrScript(['--todo']);
      expect(argumento.codigo).toBe(2);
      expect(argumento.salida).toContain('Uso: npm run eventos:purgar -- [--dry-run]');

      const variable = await correrScript([], { EVENT_OUTBOX_FAILED_RETENTION_DAYS: '3' });
      expect(variable.codigo).toBe(2);
      expect(variable.salida).toContain('EVENT_OUTBOX_FAILED_RETENTION_DAYS');
      expect(variable.salida).not.toMatch(/\b3\b/);
    });
  });

  describe('el log', () => {
    it('solo lleva conteos: ni sobres, ni pnr, ni ids, ni dueños, ni URLs', async () => {
      const publicados = await sembrar('PUBLICADO', 7, 30);
      const fallidos = await sembrar('FALLIDO', 3, 90);
      const pendientes = await sembrar('PENDIENTE', 2, 90);
      log.lineas.length = 0;

      await purga.ejecutar();

      const texto = log.texto();
      expect(texto).toMatch(/Purga de la bandeja: 7 PUBLICADO y 3 FALLIDO borrados en \d+ ms/);
      for (const id of [...publicados, ...fallidos, ...pendientes]) expect(texto).not.toContain(id);
      for (const prohibido of [marca, PNR, 'eventId', 'bookingId', 'booking.confirmed', 'http'])
        expect(texto).not.toContain(prohibido);
    });

    it('si la base falla, registra solo el nombre del error y sigue', async () => {
      const espia = jest
        .spyOn(bandeja, 'purgarLote')
        .mockRejectedValue(new Error(`secreto ${marca} con ${PNR}`));
      log.lineas.length = 0;
      try {
        await expect(purga.ejecutar()).resolves.toMatchObject({ publicados: 0, fallidos: 0 });
      } finally {
        espia.mockRestore();
      }
      const texto = log.texto();
      expect(texto).toContain('Falló la purga de la bandeja de eventos: Error');
      expect(texto).not.toContain(marca);
      expect(texto).not.toContain(PNR);
    });
  });
});

describe('Validación del entorno de la purga de la bandeja', () => {
  const base = {
    DATABASE_URL: 'postgresql://u@localhost:5432/booking_db',
    PORT: '3000',
    NODE_ENV: 'production',
    JWT_SECRET: 'j'.repeat(40),
    WEBHOOK_SECRET_KEY: 'w'.repeat(40),
  };
  const notifier = {
    ...base,
    WEBHOOKS_MODE: 'notifier',
    NOTIFIER_URL: 'https://notifier.quinde.example',
    IDENTITY_TOKEN_URL: 'https://identity.quinde.example/oauth2/token',
    NOTIFIER_CLIENT_ID: 'core-vuelos',
    NOTIFIER_CLIENT_SECRET: 's'.repeat(40),
  };
  const errorCon = (variables: Record<string, string>): string => {
    try {
      validarEntorno({ ...notifier, ...variables });
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error('validarEntorno aceptó la configuración');
  };

  it('sin las variables arranca (valen los valores por defecto) y con valores válidos también', () => {
    expect(() => validarEntorno(notifier)).not.toThrow();
    expect(() =>
      validarEntorno({
        ...notifier,
        EVENT_OUTBOX_PURGE_JOB_ENABLED: 'false',
        EVENT_OUTBOX_PURGE_INTERVAL_MINUTES: '1440',
        EVENT_OUTBOX_RETENTION_DAYS: '1',
        EVENT_OUTBOX_FAILED_RETENTION_DAYS: '365',
      }),
    ).not.toThrow();
  });

  it.each<[string, string]>([
    ['EVENT_OUTBOX_PURGE_JOB_ENABLED', 'quizas'],
    ['EVENT_OUTBOX_PURGE_INTERVAL_MINUTES', '-3'],
    ['EVENT_OUTBOX_PURGE_INTERVAL_MINUTES', '1441'],
    ['EVENT_OUTBOX_PURGE_INTERVAL_MINUTES', '2.5'],
    ['EVENT_OUTBOX_RETENTION_DAYS', '-2'],
    ['EVENT_OUTBOX_RETENTION_DAYS', '366'],
    ['EVENT_OUTBOX_RETENTION_DAYS', 'siete'],
    ['EVENT_OUTBOX_FAILED_RETENTION_DAYS', '1'],
    ['EVENT_OUTBOX_FAILED_RETENTION_DAYS', '366'],
  ])('%s=%s no arranca y el mensaje nombra la variable, no su valor', (nombre, valor) => {
    const mensaje = errorCon({ [nombre]: valor });
    expect(mensaje).toContain(nombre);
    expect(mensaje).not.toContain(valor);
  });

  it('en local no se lee ninguna, aunque esté mal', () => {
    expect(() =>
      validarEntorno({
        ...base,
        EVENT_OUTBOX_RETENTION_DAYS: '0',
        EVENT_OUTBOX_FAILED_RETENTION_DAYS: '1',
        EVENT_OUTBOX_PURGE_INTERVAL_MINUTES: 'nunca',
        EVENT_OUTBOX_PURGE_JOB_ENABLED: 'quizas',
      }),
    ).not.toThrow();
  });
});
