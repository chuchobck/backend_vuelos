import { Controller, Get, INestApplication, Post } from '@nestjs/common';
import * as request from 'supertest';
import { LimiteEstricto } from '../src/common/decorators/limite-peticiones.decorator';
import { validarEntorno } from '../src/config/entorno';
import { crearApp } from './utils/crear-app';
import { esperarProblemDetails } from './utils/problem-details';
import { Publico } from '../src/common/decorators/publico.decorator';

// Las pruebas de transversales no prueban la autenticación
@Publico()
@Controller('prueba-limite')
class ControllerDePrueba {
  @Get('a')
  a() {
    return { ruta: 'a' };
  }

  @Get('b')
  b() {
    return { ruta: 'b' };
  }

  @LimiteEstricto(2, 60)
  @Post('estricta')
  estricta() {
    return { ruta: 'estricta' };
  }
}

const LIMITE = 5;

/** Levanta una app con el límite de la prueba; cada una trae su contador en blanco. */
async function appConLimite(): Promise<INestApplication> {
  process.env.RATE_LIMIT_MAX = String(LIMITE);
  process.env.RATE_LIMIT_WINDOW_SECONDS = '60';
  return crearApp([ControllerDePrueba]);
}

describe('Límite de peticiones', () => {
  const anterior = {
    max: process.env.RATE_LIMIT_MAX,
    ventana: process.env.RATE_LIMIT_WINDOW_SECONDS,
  };

  afterAll(() => {
    for (const [variable, valor] of [
      ['RATE_LIMIT_MAX', anterior.max],
      ['RATE_LIMIT_WINDOW_SECONDS', anterior.ventana],
    ] as const) {
      if (valor === undefined) delete process.env[variable];
      else process.env[variable] = valor;
    }
  });

  describe('límite global por IP', () => {
    let app: INestApplication;
    beforeAll(async () => {
      app = await appConLimite();
    });
    afterAll(async () => {
      await app.close();
    });

    it('cuenta las peticiones de toda la API, no solo las de una ruta, y la siguiente responde 429', async () => {
      const http = () => request(app.getHttpServer());

      const primera = await http().get('/flights/v1/prueba-limite/a').expect(200);
      expect(primera.headers['x-ratelimit-limit']).toBe(String(LIMITE));
      expect(primera.headers['x-ratelimit-remaining']).toBe(String(LIMITE - 1));

      await http().get('/flights/v1/prueba-limite/b').expect(200);
      await http().get('/flights/v1/prueba-limite/a').expect(200);
      await http().get('/flights/v1/prueba-limite/b').expect(200);
      // Una ruta que no existe no llega a ningún guard: no cuenta (límite conocido, ver abajo)
      await http().get('/flights/v1/ruta-que-no-existe').expect(404);
      await http().get('/flights/v1/prueba-limite/a').expect(200);

      const excedida = await http().get('/flights/v1/prueba-limite/a');

      expect(excedida.status).toBe(429);
      esperarProblemDetails(excedida);
      expect(excedida.body).toMatchObject({
        code: 'RATE_LIMIT_EXCEEDED',
        type: 'https://api.booking-hub.com/errors/rate-limit-exceeded',
        title: 'Too Many Requests',
      });
      expect(excedida.body.detail).toMatch(/^Too many requests; retry in \d+ seconds$/);
      const reintento = Number(excedida.headers['retry-after']);
      expect(Number.isInteger(reintento)).toBe(true);
      expect(reintento).toBeGreaterThanOrEqual(1);
      expect(reintento).toBeLessThanOrEqual(60);

      // Los guards solo corren si la ruta existe: un 404 no se limita ni cuenta
      await http().get('/flights/v1/ruta-que-no-existe').expect(404);
    });

    it('el chequeo de vida no cuenta ni se corta aunque el límite ya se pasó', async () => {
      for (let i = 0; i < LIMITE + 3; i++) {
        await request(app.getHttpServer()).get('/flights/v1/health').expect(200);
      }
    });
  });

  describe('@LimiteEstricto', () => {
    let app: INestApplication;
    beforeAll(async () => {
      app = await appConLimite();
    });
    afterAll(async () => {
      await app.close();
    });

    it('corta la ruta antes de que se agote el límite global', async () => {
      const http = () => request(app.getHttpServer());

      await http().post('/flights/v1/prueba-limite/estricta').expect(201);
      await http().post('/flights/v1/prueba-limite/estricta').expect(201);
      const excedida = await http().post('/flights/v1/prueba-limite/estricta');

      expect(excedida.status).toBe(429);
      esperarProblemDetails(excedida);
      expect(excedida.body.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(Number(excedida.headers['retry-after'])).toBeGreaterThanOrEqual(1);

      // El global va en 3 de 5 y las demás rutas siguen abiertas
      await http().get('/flights/v1/prueba-limite/a').expect(200);
    });
  });
});

describe('RATE_LIMIT_* en la validación del entorno', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    JWT_SECRET: 'x'.repeat(32),
    PORT: '3000',
    NODE_ENV: 'test',
  };

  it('son opcionales y acepta enteros positivos', () => {
    expect(() => validarEntorno(base)).not.toThrow();
    expect(() =>
      validarEntorno({ ...base, RATE_LIMIT_MAX: '200', RATE_LIMIT_WINDOW_SECONDS: '30' }),
    ).not.toThrow();
  });

  it.each([['0'], ['-5'], ['1.5'], ['abc'], ['100001']])('rechaza RATE_LIMIT_MAX=%p', (valor) => {
    expect(() => validarEntorno({ ...base, RATE_LIMIT_MAX: valor })).toThrow(/RATE_LIMIT_MAX/);
  });

  it.each([['0'], ['abc'], ['86401']])('rechaza RATE_LIMIT_WINDOW_SECONDS=%p', (valor) => {
    expect(() => validarEntorno({ ...base, RATE_LIMIT_WINDOW_SECONDS: valor })).toThrow(
      /RATE_LIMIT_WINDOW_SECONDS/,
    );
  });
});
