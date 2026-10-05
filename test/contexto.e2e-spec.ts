import { Body, Controller, Get, INestApplication, Post } from '@nestjs/common';
import * as request from 'supertest';
import { obtenerContexto } from '../src/common/contexto/contexto-peticion';
import { esRequestIdValido } from '../src/common/contexto/request-id';
import { validarEntorno } from '../src/config/entorno';
import { parsearTrustProxy } from '../src/config/proxy';
import { PrismaService } from '../src/prisma/prisma.service';
import { crearApp } from './utils/crear-app';
import { esperarProblemDetails } from './utils/problem-details';

/** Secuencias de color ANSI de los logs de Nest (ESC = código 27). */
const COLORES_ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

@Controller('prueba-contexto')
class ControllerDePrueba {
  constructor(private readonly prisma: PrismaService) {}

  @Get('contexto')
  async contexto() {
    // Una espera de por medio: el contexto tiene que seguir siendo el de esta petición
    await new Promise((resolver) => setTimeout(resolver, 5));
    return obtenerContexto();
  }

  /** Lee el contexto después de que el parser consumió el cuerpo. */
  @Post('con-cuerpo')
  conCuerpo(@Body() _cuerpo: object) {
    return { requestId: obtenerContexto()?.requestId ?? null };
  }

  /** Lo que ve la base como actor dentro de una transacción auditada, y lo que queda en auditoria. */
  @Get('actor')
  async actor() {
    let resultado: unknown;
    await this.prisma
      .transaccionAuditada(async (tx) => {
        await tx.pais.create({ data: { codigo_iso2: 'ZY', codigo_iso3: 'ZYY', nombre: 'Zy' } });
        resultado = (
          await tx.$queryRawUnsafe<unknown[]>(
            `SELECT current_setting('app.direccion_ip', true) AS ip,
                    current_setting('app.id_usuario', true) AS usuario,
                    (SELECT host(direccion_ip) FROM vuelos.auditoria ORDER BY id DESC LIMIT 1) AS auditada`,
          )
        )[0];
        throw new Error('revertir');
      })
      .catch((error: Error) => {
        if (error.message !== 'revertir') throw error;
      });
    return resultado;
  }

  @Get('interno')
  interno() {
    throw new Error('fallo interno de prueba');
  }
}

describe('X-Request-Id y contexto de la petición', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await crearApp([ControllerDePrueba]);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('X-Request-Id', () => {
    it('lo genera (UUID) si no llega y lo devuelve en la respuesta', async () => {
      const respuesta = await http().get('/flights/v1/health').expect(200);

      expect(respuesta.headers['x-request-id']).toMatch(UUID);
    });

    it('cada petición sin cabecera recibe uno distinto', async () => {
      const [a, b] = await Promise.all([
        http().get('/flights/v1/health'),
        http().get('/flights/v1/health'),
      ]);

      expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
    });

    it.each([
      'cliente-123456',
      '8d1f3c2e-aaaa-4bbb-8ccc-0123456789ab',
      'trace.id_01-ABC',
      'a'.repeat(64),
    ])('respeta uno válido: %s', async (id) => {
      const respuesta = await http().get('/flights/v1/health').set('X-Request-Id', id);

      expect(respuesta.headers['x-request-id']).toBe(id);
    });

    it.each([
      ['demasiado corto', 'abc'],
      ['con espacios', 'tiene espacios aqui'],
      ['demasiado largo', 'a'.repeat(65)],
      ['con caracteres fuera de la lista', 'id;drop-table-1234'],
      ['empieza por guion', '-abcdefghij'],
    ])(
      'reemplaza uno inválido (%s) por uno generado, sin rechazar la petición',
      async (_caso, id) => {
        const respuesta = await http()
          .get('/flights/v1/health')
          .set('X-Request-Id', id)
          .expect(200);

        expect(respuesta.headers['x-request-id']).not.toBe(id);
        expect(respuesta.headers['x-request-id']).toMatch(UUID);
      },
    );

    it('lo llevan también las respuestas de error: 404, 405 y 400', async () => {
      const id = 'id-de-error-0001';
      const notFound = await http().get('/flights/v1/nada').set('X-Request-Id', id);
      const metodo = await http().post('/flights/v1/health').set('X-Request-Id', id);
      const invalido = await http()
        .post('/flights/v1/prueba-contexto/con-cuerpo')
        .set('X-Request-Id', id)
        .set('Content-Type', 'application/json')
        .send('{"roto":');

      for (const respuesta of [notFound, metodo, invalido]) {
        expect(respuesta.headers['x-request-id']).toBe(id);
        esperarProblemDetails(respuesta);
      }
      expect([notFound.status, metodo.status, invalido.status]).toEqual([404, 405, 400]);
    });

    it('lo lleva el 413 del parser, que falla antes de llegar a las rutas', async () => {
      const respuesta = await http()
        .post('/flights/v1/prueba-contexto/con-cuerpo')
        .set('X-Request-Id', 'id-de-413-00001')
        .send({ texto: 'a'.repeat(101 * 1024) });

      expect(respuesta.status).toBe(413);
      expect(respuesta.headers['x-request-id']).toBe('id-de-413-00001');
    });

    it('no se agrega al cuerpo del error: ProblemDetails no admite campos extra', async () => {
      const respuesta = await http().get('/flights/v1/nada').set('X-Request-Id', 'id-sin-campo-01');

      expect(respuesta.text).not.toContain('id-sin-campo-01');
      esperarProblemDetails(respuesta);
    });
  });

  describe('contexto por petición (AsyncLocalStorage)', () => {
    it('trae el request id, la IP del cliente y el hueco del usuario', async () => {
      const respuesta = await http()
        .get('/flights/v1/prueba-contexto/contexto')
        .set('X-Request-Id', 'ctx-id-000001')
        .expect(200);

      expect(respuesta.body).toEqual({
        requestId: 'ctx-id-000001',
        ip: '127.0.0.1',
        usuario: null,
      });
    });

    it('peticiones simultáneas no se mezclan', async () => {
      await app.listen(0); // un solo servidor abierto para las 25 peticiones
      const ids = Array.from({ length: 25 }, (_, i) => `concurrente-${String(i).padStart(4, '0')}`);

      const respuestas = await Promise.all(
        ids.map((id) => http().get('/flights/v1/prueba-contexto/contexto').set('X-Request-Id', id)),
      );

      expect(respuestas.map((r) => r.body.requestId)).toEqual(ids);
    });

    it('sobrevive al parser del cuerpo', async () => {
      const respuesta = await http()
        .post('/flights/v1/prueba-contexto/con-cuerpo')
        .set('X-Request-Id', 'tras-cuerpo-001')
        .send({ campo: 'valor', otro: 'x'.repeat(5000) })
        .expect(201);

      expect(respuesta.body).toEqual({ requestId: 'tras-cuerpo-001' });
    });

    it('fuera de una petición no hay contexto', () => {
      expect(obtenerContexto()).toBeUndefined();
    });
  });

  describe('PrismaService fuera de una petición', () => {
    it('sin contexto el actor queda vacío; con `actor` explícito se usa ese', async () => {
      const prisma = app.get(PrismaService);
      const leer = (tx: Parameters<Parameters<PrismaService['transaccionAuditada']>[0]>[0]) =>
        tx.$queryRawUnsafe<{ ip: string; usuario: string }[]>(
          `SELECT current_setting('app.direccion_ip', true) AS ip, current_setting('app.id_usuario', true) AS usuario`,
        );

      expect(await prisma.transaccionAuditada(leer)).toEqual([{ ip: '', usuario: '' }]);
      expect(
        await prisma.transaccionAuditada(leer, {
          actor: { idUsuario: 'tarea-vencer-retenciones', direccionIp: null },
        }),
      ).toEqual([{ ip: '', usuario: 'tarea-vencer-retenciones' }]);
    });
  });
});

describe('IP del cliente y trust proxy', () => {
  const anterior = process.env.TRUST_PROXY;
  let app: INestApplication;

  afterEach(async () => {
    await app.close();
    if (anterior === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = anterior;
  });

  it('sin TRUST_PROXY se ignora X-Forwarded-For: no se puede falsear la IP', async () => {
    delete process.env.TRUST_PROXY;
    app = await crearApp([ControllerDePrueba]);

    const respuesta = await request(app.getHttpServer())
      .get('/flights/v1/prueba-contexto/contexto')
      .set('X-Forwarded-For', '203.0.113.7')
      .expect(200);

    expect(respuesta.body.ip).toBe('127.0.0.1');
  });

  it('con TRUST_PROXY=1 la IP es la de X-Forwarded-For, y un valor falseado a la izquierda no cuenta', async () => {
    process.env.TRUST_PROXY = '1';
    app = await crearApp([ControllerDePrueba]);

    const respuesta = await request(app.getHttpServer())
      .get('/flights/v1/prueba-contexto/contexto')
      .set('X-Forwarded-For', '198.51.100.99, 203.0.113.7')
      .expect(200);

    expect(respuesta.body.ip).toBe('203.0.113.7');
  });

  it('la IP llega a la base: app.direccion_ip y la fila de auditoria', async () => {
    process.env.TRUST_PROXY = '1';
    app = await crearApp([ControllerDePrueba]);

    const respuesta = await request(app.getHttpServer())
      .get('/flights/v1/prueba-contexto/actor')
      .set('X-Forwarded-For', '203.0.113.7')
      .expect(200);

    expect(respuesta.body).toEqual({ ip: '203.0.113.7', usuario: '', auditada: '203.0.113.7' });
  });
});

describe('X-Request-Id en los logs', () => {
  let app: INestApplication;
  let escrito: string[];
  let espias: jest.SpyInstance[];

  beforeAll(async () => {
    app = await crearApp([ControllerDePrueba], { logs: true });
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
    await app.close();
  });

  // Las líneas de log salen con colores ANSI: se quitan para buscar el texto
  const lineas = () => escrito.join('').replace(COLORES_ANSI, '').split('\n');

  it('la línea de acceso lleva el id, el método, la ruta, el status y la IP', async () => {
    await request(app.getHttpServer())
      .get('/flights/v1/health?x=secreto')
      .set('X-Request-Id', 'log-acceso-0001');
    await new Promise((resolver) => setTimeout(resolver, 20));

    const linea = lineas().find((l) => l.includes('log-acceso-0001'));
    expect(linea).toMatch(
      /\[HTTP\] \[log-acceso-0001\] GET \/flights\/v1\/health 200 [\d.]+ms ip=127\.0\.0\.1/,
    );
    expect(linea).not.toContain('secreto'); // la query no se registra
  });

  it('un error interno también deja el id en su línea, con el stack solo en el log', async () => {
    const respuesta = await request(app.getHttpServer())
      .get('/flights/v1/prueba-contexto/interno')
      .set('X-Request-Id', 'log-error-0001');
    await new Promise((resolver) => setTimeout(resolver, 20));

    expect(respuesta.text).not.toContain('fallo interno');
    const delError = lineas().filter((l) => l.includes('log-error-0001'));
    expect(delError.some((l) => l.includes('[Errores]') && l.includes('→ 500'))).toBe(true);
    expect(lineas().some((l) => l.includes('fallo interno de prueba'))).toBe(true);
  });

  it('el 413 del parser también deja su línea de error con el id', async () => {
    await request(app.getHttpServer())
      .post('/flights/v1/prueba-contexto/con-cuerpo')
      .set('X-Request-Id', 'log-parser-0001')
      .send({ texto: 'a'.repeat(101 * 1024) });
    await new Promise((resolver) => setTimeout(resolver, 20));

    expect(
      lineas().filter((l) => l.includes('log-parser-0001') && l.includes('413')).length,
    ).toBeGreaterThan(0);
  });
});

describe('Validación de X-Request-Id y de TRUST_PROXY', () => {
  it('esRequestIdValido', () => {
    expect(esRequestIdValido('abcd1234')).toBe(true);
    expect(esRequestIdValido('abcd123')).toBe(false);
    expect(esRequestIdValido(['abcd1234', 'abcd5678'])).toBe(false);
    expect(esRequestIdValido(undefined)).toBe(false);
  });

  it.each([
    [undefined, false],
    ['', false],
    ['false', false],
    ['0', false],
    ['1', 1],
    ['2', 2],
    ['loopback', ['loopback']],
    ['10.0.0.0/8, 192.168.0.1', ['10.0.0.0/8', '192.168.0.1']],
    ['loopback, ::1, fd00::/8', ['loopback', '::1', 'fd00::/8']],
  ])('parsea %p', (valor, esperado) => {
    expect(parsearTrustProxy(valor)).toEqual(esperado);
  });

  it.each([
    ['true'],
    ['abc'],
    ['1000'],
    ['-1'],
    ['10.0.0.0/33'],
    ['10.0.0.0/8/8'],
    ['1,loopback'],
    ['*'],
  ])('rechaza %p', (valor) => {
    expect(parsearTrustProxy(valor)).toBeUndefined();
  });

  it('validarEntorno rechaza TRUST_PROXY=true y explica por qué', () => {
    const base = {
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      JWT_SECRET: 'x'.repeat(32),
      PORT: '3000',
      NODE_ENV: 'test',
    };

    expect(() => validarEntorno({ ...base, TRUST_PROXY: '1' })).not.toThrow();
    expect(() => validarEntorno({ ...base, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY.*falsear/);
  });
});
