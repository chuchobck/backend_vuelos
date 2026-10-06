import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID } from 'node:crypto';
import { validarEntorno } from '../src/config/entorno';
import { CifradoSecreto } from '../src/modules/vuelos/operaciones/webhook/cifrado-secreto';
import { ClienteWebhookHttp } from '../src/modules/vuelos/operaciones/webhook/cliente-webhook-http';
import {
  direccionProhibida,
  motivoDestinoInvalido,
} from '../src/modules/vuelos/operaciones/webhook/destino-permitido';
import {
  proximoIntentoTras,
  REGLAS_ENTREGA,
} from '../src/modules/vuelos/operaciones/webhook/entrega-webhooks';
import { firmar, firmaValida } from '../src/modules/vuelos/operaciones/webhook/firma-webhook';
import { enmascarar } from '../src/modules/vuelos/operaciones/webhook/webhook.mapper';
import { Receptor } from './utils/receptor-webhook';

// Piezas puras de los webhooks, sin la API ni la base (el runner del proyecto solo corre
// test/*.e2e-spec.ts, de ahí el nombre).

const configDe = (valores: Record<string, string>) =>
  ({ get: (k: string) => valores[k], getOrThrow: (k: string) => valores[k] }) as ConfigService;

describe('firma de las entregas', () => {
  const secreto = 'secreto-de-prueba-para-firmar-01';
  const cuerpo = '{"eventId":"e1","eventType":"booking.confirmed"}';

  it('es sha256= más el HMAC-SHA256 en hexadecimal de "timestamp.cuerpo"', () => {
    const esperada = createHmac('sha256', secreto).update(`1700000000.${cuerpo}`).digest('hex');
    expect(firmar(secreto, 1700000000, cuerpo)).toBe(`sha256=${esperada}`);
  });

  it('cambia con el secreto, el timestamp o el cuerpo; es determinista', () => {
    const base = firmar(secreto, 1700000000, cuerpo);
    expect(firmar(secreto, 1700000000, cuerpo)).toBe(base);
    expect(firmar('otro-secreto-de-prueba-0002', 1700000000, cuerpo)).not.toBe(base);
    expect(firmar(secreto, 1700000001, cuerpo)).not.toBe(base);
    expect(firmar(secreto, 1700000000, `${cuerpo} `)).not.toBe(base);
  });

  it('firmaValida acepta la correcta y rechaza cualquier otra, también de otro largo', () => {
    const firma = firmar(secreto, 1700000000, cuerpo);
    expect(firmaValida(secreto, 1700000000, cuerpo, firma)).toBe(true);
    expect(firmaValida(secreto, 1700000000, cuerpo, firma.slice(0, -1))).toBe(false);
    expect(firmaValida(secreto, 1700000000, cuerpo, '')).toBe(false);
    expect(firmaValida(secreto, 1700000000, cuerpo, firma.toUpperCase())).toBe(false);
  });
});

describe('espera entre reintentos', () => {
  const t0 = new Date('2026-01-01T00:00:00.000Z');
  const tras = (n: number) => proximoIntentoTras(n, t0);

  it('1 min, 5 min, 30 min y 2 h tras los intentos 1 a 4', () => {
    const minutos = [1, 2, 3, 4].map((n) => (tras(n)!.getTime() - t0.getTime()) / 60_000);
    expect(minutos).toEqual([1, 5, 30, 120]);
  });

  it('tras el quinto intento ya no hay otro (y la espera de 6 h de la lista no se usa)', () => {
    expect(REGLAS_ENTREGA.maximoIntentos).toBe(5);
    expect(tras(5)).toBeNull();
    expect(tras(6)).toBeNull();
  });
});

describe('secreto del webhook', () => {
  const cifrado = new CifradoSecreto(
    configDe({ WEBHOOK_SECRET_KEY: 'clave-de-pruebas-de-los-webhooks-0123456789' }),
  );

  it('enmascara con **** y los últimos 4 caracteres', () => {
    expect(enmascarar('un-secreto-compartido-largo')).toBe('****argo');
    expect(enmascarar('abcdefghijklmnop')).toBe('****mnop');
  });

  it('cifra de forma reversible y nunca deja el secreto a la vista', () => {
    const secreto = 'un-secreto-compartido-largo';
    const guardado = cifrado.cifrar(secreto);
    expect(guardado).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(guardado).not.toContain(secreto);
    expect(Buffer.from(guardado.slice(3), 'base64url').toString('utf8')).not.toContain(secreto);
    expect(cifrado.descifrar(guardado)).toBe(secreto);
  });

  it('el mismo secreto cifrado dos veces da textos distintos (nonce al azar)', () => {
    expect(cifrado.cifrar('un-secreto-compartido-largo')).not.toBe(
      cifrado.cifrar('un-secreto-compartido-largo'),
    );
  });

  it('un valor alterado, de otra versión o cifrado con otra clave no se descifra', () => {
    const guardado = cifrado.cifrar('un-secreto-compartido-largo');
    const bytes = Buffer.from(guardado.slice(3), 'base64url');
    bytes[bytes.length - 1] ^= 1;
    expect(() => cifrado.descifrar(`v1.${bytes.toString('base64url')}`)).toThrow();
    expect(() => cifrado.descifrar(guardado.replace('v1.', 'v2.'))).toThrow();
    expect(() => cifrado.descifrar('sin-formato')).toThrow();
    const otraClave = new CifradoSecreto(
      configDe({ WEBHOOK_SECRET_KEY: 'otra-clave-de-pruebas-de-los-webhooks-99' }),
    );
    expect(() => otraClave.descifrar(guardado)).toThrow();
  });

  it('el error al descifrar no trae el valor guardado', () => {
    const guardado = cifrado.cifrar('un-secreto-compartido-largo');
    const otraClave = new CifradoSecreto(
      configDe({ WEBHOOK_SECRET_KEY: 'otra-clave-de-pruebas-de-los-webhooks-99' }),
    );
    try {
      otraClave.descifrar(guardado);
      fail('debía lanzar');
    } catch (error) {
      expect((error as Error).message).not.toContain(guardado.slice(3, 20));
      expect((error as Error).message).not.toContain('un-secreto-compartido-largo');
    }
  });
});

describe('SSRF: qué direcciones se aceptan', () => {
  const prod = { produccion: true };
  const dev = { produccion: false };

  it.each([
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.0.1',
    '169.254.169.254',
    '169.254.0.1',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '240.0.0.1',
    'fe80::1',
    'fd12:3456::1',
    'fc00::1',
    '::',
    'ff02::1',
    '::ffff:10.0.0.1',
    '::ffff:169.254.169.254',
  ])('%s se rechaza siempre (producción o no)', (ip) => {
    expect(direccionProhibida(ip, prod)).toBe(true);
    expect(direccionProhibida(ip, dev)).toBe(true);
  });

  it.each(['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1'])(
    'el loopback %s solo se acepta fuera de producción',
    (ip) => {
      expect(direccionProhibida(ip, prod)).toBe(true);
      expect(direccionProhibida(ip, dev)).toBe(false);
    },
  );

  it.each(['8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '192.169.0.1', '2606:4700::1111'])(
    '%s, pública, se acepta',
    (ip) => {
      expect(direccionProhibida(ip, prod)).toBe(false);
    },
  );

  describe('motivoDestinoInvalido en producción', () => {
    it.each([
      ['http://example.com/hook', 'must use https'],
      ['http://localhost/hook', 'must use https'],
      ['https://localhost/hook', 'host resolves to a network that is not allowed'],
      ['https://127.0.0.1/hook', 'host resolves to a network that is not allowed'],
      ['https://[::1]/hook', 'host resolves to a network that is not allowed'],
      [
        'https://169.254.169.254/latest/meta-data',
        'host resolves to a network that is not allowed',
      ],
      ['https://10.0.0.5/hook', 'host resolves to a network that is not allowed'],
      ['https://user:clave@8.8.8.8/hook', 'must not include credentials'],
      ['ftp://8.8.8.8/hook', 'must use https'],
      ['no es una url', 'must be a valid URL'],
    ])('%s → %s', async (url, motivo) => {
      expect(await motivoDestinoInvalido(url, prod)).toBe(motivo);
    });

    it('https hacia una IP pública es válido', async () => {
      expect(await motivoDestinoInvalido('https://8.8.8.8/hook', prod)).toBeNull();
    });
  });

  describe('motivoDestinoInvalido fuera de producción', () => {
    it('http://localhost y http://127.0.0.1 sí; http hacia una IP pública o una red privada no', async () => {
      expect(await motivoDestinoInvalido('http://localhost:3000/hook', dev)).toBeNull();
      expect(await motivoDestinoInvalido('http://127.0.0.1:3000/hook', dev)).toBeNull();
      expect(await motivoDestinoInvalido('http://8.8.8.8/hook', dev)).toBe('must use https');
      expect(await motivoDestinoInvalido('http://192.168.1.1/hook', dev)).toBe(
        'host resolves to a network that is not allowed',
      );
      expect(await motivoDestinoInvalido('http://169.254.169.254/x', dev)).toBe(
        'host resolves to a network that is not allowed',
      );
    });
  });
});

describe('ClienteWebhookHttp', () => {
  let receptor: Receptor;
  const cabeceras = { 'Content-Type': 'application/json', 'X-Webhook-Id': 'e1' };
  const desarrollo = new ClienteWebhookHttp(configDe({ NODE_ENV: 'test' }));
  const produccion = new ClienteWebhookHttp(configDe({ NODE_ENV: 'production' }));

  beforeAll(async () => {
    receptor = new Receptor();
    await receptor.iniciar();
  });
  beforeEach(() => {
    receptor.recibidos = [];
    receptor.codigo = 200;
    receptor.cabecerasRespuesta = {};
    receptor.mudo = false;
  });
  afterAll(() => receptor.detener());

  it('hace un POST con las cabeceras y el cuerpo tal cual, y devuelve el código', async () => {
    const cuerpo = '{"a":1}';
    const resultado = await desarrollo.enviar({
      url: receptor.url('/ok'),
      cabeceras,
      cuerpo,
    });
    expect(resultado).toEqual({ codigoHttp: 200, error: null });
    const [recibido] = receptor.de('/ok');
    expect(recibido.cuerpo).toBe(cuerpo);
    expect(recibido.cabeceras['content-type']).toBe('application/json');
    expect(recibido.cabeceras['x-webhook-id']).toBe('e1');
    expect(recibido.cabeceras['content-length']).toBe(String(Buffer.byteLength(cuerpo)));
  });

  it.each([204, 400, 404, 500, 503])('devuelve el %s sin convertirlo en error', async (codigo) => {
    receptor.codigo = codigo;
    expect(await desarrollo.enviar({ url: receptor.url('/c'), cabeceras, cuerpo: '{}' })).toEqual({
      codigoHttp: codigo,
      error: null,
    });
  });

  it('no sigue redirecciones: una 302 es la respuesta y el destino nunca se visita', async () => {
    const destino = new Receptor();
    await destino.iniciar();
    try {
      receptor.codigo = 302;
      receptor.cabecerasRespuesta = { Location: destino.url('/interno') };
      const resultado = await desarrollo.enviar({
        url: receptor.url('/r'),
        cabeceras,
        cuerpo: '{}',
      });
      expect(resultado).toEqual({ codigoHttp: 302, error: null });
      expect(destino.recibidos).toEqual([]);
    } finally {
      await destino.detener();
    }
  });

  it('corta a los 5 s si el receptor no contesta (TIMEOUT)', async () => {
    receptor.mudo = true;
    const inicio = Date.now();
    const resultado = await desarrollo.enviar({
      url: receptor.url('/mudo'),
      cabeceras,
      cuerpo: '{}',
    });
    const tardo = Date.now() - inicio;
    expect(resultado).toEqual({ codigoHttp: null, error: 'TIMEOUT' });
    expect(tardo).toBeGreaterThanOrEqual(4_500);
    expect(tardo).toBeLessThan(8_000);
  }, 15_000);

  it('un puerto cerrado es ECONNREFUSED, sin host ni puerto en el error', async () => {
    const cerrado = new Receptor();
    await cerrado.iniciar();
    const url = cerrado.url('/x');
    await cerrado.detener();
    const resultado = await desarrollo.enviar({ url, cabeceras, cuerpo: '{}' });
    expect(resultado).toEqual({ codigoHttp: null, error: 'ECONNREFUSED' });
  });

  it('un nombre que no existe es ENOTFOUND (o EAI_AGAIN sin red), siempre un código corto', async () => {
    const resultado = await desarrollo.enviar({
      url: `http://no-existe-${randomUUID()}.invalid/hook`,
      cabeceras,
      cuerpo: '{}',
    });
    expect(resultado.codigoHttp).toBeNull();
    expect(resultado.error).toMatch(/^[A-Z_]{4,20}$/);
  });

  describe('SSRF en el momento de enviar', () => {
    it.each([
      'http://169.254.169.254/latest/meta-data',
      'http://10.0.0.5/hook',
      'http://192.168.1.10/hook',
      'http://[fe80::1]/hook',
      'http://[::ffff:10.0.0.1]/hook',
      'http://0.0.0.0/hook',
    ])('%s no se contacta, ni en desarrollo', async (url) => {
      expect(await desarrollo.enviar({ url, cabeceras, cuerpo: '{}' })).toEqual({
        codigoHttp: null,
        error: 'DESTINATION_NOT_ALLOWED',
      });
    });

    it('en producción tampoco el loopback, ni por IP ni por nombre (localhost resuelve a 127.0.0.1)', async () => {
      const url = receptor.url('/prod');
      expect(await produccion.enviar({ url, cabeceras, cuerpo: '{}' })).toEqual({
        codigoHttp: null,
        error: 'INSECURE_URL',
      });
      expect(
        await produccion.enviar({
          url: url.replace('http://', 'https://'),
          cabeceras,
          cuerpo: '{}',
        }),
      ).toEqual({ codigoHttp: null, error: 'DESTINATION_NOT_ALLOWED' });
      const puerto = new URL(url).port;
      expect(
        await produccion.enviar({
          url: `https://localhost:${puerto}/prod`,
          cabeceras,
          cuerpo: '{}',
        }),
      ).toEqual({ codigoHttp: null, error: 'DESTINATION_NOT_ALLOWED' });
      expect(receptor.recibidos).toEqual([]);
    });

    it('en producción http (aunque sea a una IP pública) no se usa', async () => {
      expect(
        await produccion.enviar({ url: 'http://8.8.8.8/hook', cabeceras, cuerpo: '{}' }),
      ).toEqual({ codigoHttp: null, error: 'INSECURE_URL' });
    });

    it('una URL ilegible es INVALID_URL', async () => {
      expect(
        await desarrollo.enviar({ url: 'esto no es una url', cabeceras, cuerpo: '{}' }),
      ).toEqual({ codigoHttp: null, error: 'INVALID_URL' });
    });
  });
});

describe('variables de entorno de los webhooks', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    JWT_SECRET: 'x'.repeat(32),
    PORT: '3000',
    NODE_ENV: 'test',
  };

  it('WEBHOOK_SECRET_KEY es obligatoria y de al menos 32 caracteres', () => {
    expect(() => validarEntorno(base)).toThrow(/WEBHOOK_SECRET_KEY es obligatoria/);
    expect(() => validarEntorno({ ...base, WEBHOOK_SECRET_KEY: 'k'.repeat(31) })).toThrow(
      /WEBHOOK_SECRET_KEY debe tener al menos 32 caracteres/,
    );
    expect(() => validarEntorno({ ...base, WEBHOOK_SECRET_KEY: 'k'.repeat(32) })).not.toThrow();
  });

  it('el error por una clave corta no repite la clave', () => {
    const corta = 'clave-corta-secreta';
    try {
      validarEntorno({ ...base, WEBHOOK_SECRET_KEY: corta });
      fail('debía lanzar');
    } catch (error) {
      expect((error as Error).message).not.toContain(corta);
    }
  });

  it('el proceso de entrega es opcional: true/false y de 5 a 3600 segundos', () => {
    const conClave = { ...base, WEBHOOK_SECRET_KEY: 'k'.repeat(32) };
    expect(() => validarEntorno(conClave)).not.toThrow();
    expect(() =>
      validarEntorno({
        ...conClave,
        WEBHOOK_DELIVERY_JOB_ENABLED: 'false',
        WEBHOOK_DELIVERY_JOB_INTERVAL_SECONDS: '10',
      }),
    ).not.toThrow();
    expect(() => validarEntorno({ ...conClave, WEBHOOK_DELIVERY_JOB_ENABLED: 'si' })).toThrow(
      /WEBHOOK_DELIVERY_JOB_ENABLED debe ser true o false/,
    );
    for (const segundos of ['4', '3601', 'abc']) {
      expect(() =>
        validarEntorno({ ...conClave, WEBHOOK_DELIVERY_JOB_INTERVAL_SECONDS: segundos }),
      ).toThrow(/WEBHOOK_DELIVERY_JOB_INTERVAL_SECONDS/);
    }
  });
});
