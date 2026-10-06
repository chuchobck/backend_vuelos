import { Body, Controller, INestApplication, Post } from '@nestjs/common';
import * as request from 'supertest';
import { validarEntorno } from '../src/config/entorno';
import { crearApp } from './utils/crear-app';
import { esperarProblemDetails } from './utils/problem-details';
import { Publico } from '../src/common/decorators/publico.decorator';

// Las pruebas de transversales no prueban la autenticación
@Publico()
@Controller('prueba-seguridad')
class ControllerDePrueba {
  @Post()
  eco(@Body() cuerpo: object) {
    return { bytes: JSON.stringify(cuerpo).length };
  }
}

const ORIGEN_PERMITIDO = 'https://quinde.example.com';
const OTRO_ORIGEN_PERMITIDO = 'http://localhost:5173';
const ORIGEN_AJENO = 'https://sitio-ajeno.example.org';

describe('Seguridad HTTP', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());
  const corsAnterior = process.env.CORS_ORIGINS;

  beforeAll(async () => {
    process.env.CORS_ORIGINS = `${ORIGEN_PERMITIDO}, ${OTRO_ORIGEN_PERMITIDO}`;
    app = await crearApp([ControllerDePrueba]);
  });

  afterAll(async () => {
    await app.close();
    if (corsAnterior === undefined) delete process.env.CORS_ORIGINS;
    else process.env.CORS_ORIGINS = corsAnterior;
  });

  describe('helmet', () => {
    it('agrega las cabeceras de seguridad y quita X-Powered-By', async () => {
      const respuesta = await http().get('/flights/v1/health').expect(200);

      expect(respuesta.headers['x-content-type-options']).toBe('nosniff');
      expect(respuesta.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(respuesta.headers['strict-transport-security']).toContain('max-age=');
      expect(respuesta.headers['content-security-policy']).toContain("default-src 'self'");
      expect(respuesta.headers['referrer-policy']).toBe('no-referrer');
      expect(respuesta.headers['x-powered-by']).toBeUndefined();
    });

    it('también las lleva un error', async () => {
      const respuesta = await http().get('/flights/v1/no-existe').expect(404);

      expect(respuesta.headers['x-content-type-options']).toBe('nosniff');
    });

    it('Swagger UI sigue abriendo: la página, su script y el OpenAPI', async () => {
      const pagina = await http().get('/api/docs/').expect(200);
      expect(pagina.text).toContain('swagger-ui');
      // La política deja cargar el script y los estilos de la misma ruta
      const csp = pagina.headers['content-security-policy'];
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("style-src 'self'");
      expect(csp).toContain('img-src');
      expect(csp).toContain('data:');
      // En desarrollo no se sube a https: en http://localhost Swagger no cargaría
      expect(csp).not.toContain('upgrade-insecure-requests');

      await http().get('/api/docs/swagger-ui-bundle.js').expect(200);
      await http().get('/api/docs/swagger-ui-init.js').expect(200);
      const openapi = await http().get('/api/docs-json').expect(200);
      expect(openapi.body.info.title).toContain('Quinde');
    });
  });

  describe('CORS', () => {
    it('un origen de la lista recibe Access-Control-Allow-Origin', async () => {
      const respuesta = await http().get('/flights/v1/health').set('Origin', ORIGEN_PERMITIDO);

      expect(respuesta.headers['access-control-allow-origin']).toBe(ORIGEN_PERMITIDO);
      expect(respuesta.headers['access-control-expose-headers']).toContain('Retry-After');
      expect(respuesta.headers['vary']).toContain('Origin');
    });

    it('el segundo origen de la lista (con espacio tras la coma) también', async () => {
      const respuesta = await http().get('/flights/v1/health').set('Origin', OTRO_ORIGEN_PERMITIDO);

      expect(respuesta.headers['access-control-allow-origin']).toBe(OTRO_ORIGEN_PERMITIDO);
    });

    it('un origen que no está en la lista no recibe cabeceras CORS', async () => {
      const respuesta = await http().get('/flights/v1/health').set('Origin', ORIGEN_AJENO);

      expect(respuesta.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('el preflight de un origen permitido responde 204 con métodos y cabeceras', async () => {
      const respuesta = await http()
        .options('/flights/v1/bookings')
        .set('Origin', ORIGEN_PERMITIDO)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'authorization,idempotency-key,content-type');

      expect(respuesta.status).toBe(204);
      expect(respuesta.headers['access-control-allow-origin']).toBe(ORIGEN_PERMITIDO);
      expect(respuesta.headers['access-control-allow-methods']).toContain('POST');
      expect(respuesta.headers['access-control-allow-headers']).toMatch(/Idempotency-Key/i);
      expect(respuesta.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('el preflight de un origen ajeno no recibe cabeceras CORS', async () => {
      const respuesta = await http()
        .options('/flights/v1/bookings')
        .set('Origin', ORIGEN_AJENO)
        .set('Access-Control-Request-Method', 'POST');

      expect(respuesta.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('un error también lleva Access-Control-Allow-Origin para el origen permitido', async () => {
      const respuesta = await http().get('/flights/v1/no-existe').set('Origin', ORIGEN_PERMITIDO);

      expect(respuesta.status).toBe(404);
      expect(respuesta.headers['access-control-allow-origin']).toBe(ORIGEN_PERMITIDO);
    });
  });

  describe('tope del cuerpo (100 kB)', () => {
    const cuerpoDe = (bytes: number) => ({ texto: 'a'.repeat(bytes) });

    it('un cuerpo de 90 kB pasa', async () => {
      await http()
        .post('/flights/v1/prueba-seguridad')
        .send(cuerpoDe(90 * 1024))
        .expect(201);
    });

    it('un cuerpo de 101 kB responde 413 como ProblemDetails', async () => {
      const respuesta = await http()
        .post('/flights/v1/prueba-seguridad')
        .send(cuerpoDe(101 * 1024));

      expect(respuesta.status).toBe(413);
      esperarProblemDetails(respuesta);
    });

    it('un formulario de más de 100 kB también responde 413', async () => {
      const respuesta = await http()
        .post('/flights/v1/prueba-seguridad')
        .type('form')
        .send(`texto=${'a'.repeat(101 * 1024)}`);

      expect(respuesta.status).toBe(413);
      esperarProblemDetails(respuesta);
    });
  });

  describe('Content-Type del cuerpo', () => {
    it.each([
      ['text/plain', 'hola'],
      ['application/xml', '<a>1</a>'],
      ['application/x-www-form-urlencoded', 'texto=hola'],
      ['multipart/form-data; boundary=x', '--x--'],
    ])('%s responde 415 como ProblemDetails, sin llegar al controller', async (tipo, cuerpo) => {
      const respuesta = await http()
        .post('/flights/v1/prueba-seguridad')
        .set('Content-Type', tipo)
        .send(cuerpo);
      expect(respuesta.status).toBe(415);
      esperarProblemDetails(respuesta);
      expect(respuesta.body.title).toBe('Unsupported Media Type');
    });

    it('un cuerpo sin Content-Type también es 415', async () => {
      const respuesta = await http()
        .post('/flights/v1/prueba-seguridad')
        .set('Content-Type', '')
        .send(Buffer.from('{"texto":"a"}'));
      expect(respuesta.status).toBe(415);
    });

    it('application/json (con charset) pasa; un +json no, porque el parser no lo lee', async () => {
      await http()
        .post('/flights/v1/prueba-seguridad')
        .set('Content-Type', 'application/json; charset=utf-8')
        .send('{"texto":"a"}')
        .expect(201);
      await http()
        .post('/flights/v1/prueba-seguridad')
        .set('Content-Type', 'application/merge-patch+json')
        .send('{"texto":"a"}')
        .expect(415);
    });

    it('un POST sin cuerpo no exige Content-Type', async () => {
      await http().post('/flights/v1/prueba-seguridad').expect(201);
    });
  });
});

describe('CORS_ORIGINS en la validación del entorno', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    WEBHOOK_SECRET_KEY: 'k'.repeat(32),
    JWT_SECRET: 'x'.repeat(32),
    PORT: '3000',
    NODE_ENV: 'test',
  };

  it.each([
    [undefined],
    [''],
    ['https://quinde.example.com'],
    ['https://quinde.example.com,http://localhost:5173'],
    [' https://quinde.example.com , http://localhost:5173 '],
  ])('acepta %p', (valor) => {
    expect(() => validarEntorno({ ...base, CORS_ORIGINS: valor })).not.toThrow();
  });

  it.each([
    ['*'],
    ['https://quinde.example.com/'],
    ['https://quinde.example.com/ruta'],
    ['quinde.example.com'],
    ['ftp://quinde.example.com'],
    ['https://ok.example.com,*'],
    ['HTTPS://QUINDE.EXAMPLE.COM'],
  ])('rechaza %p y dice cuáles son inválidos', (valor) => {
    expect(() => validarEntorno({ ...base, CORS_ORIGINS: valor })).toThrow(
      /CORS_ORIGINS.*inválidos/,
    );
  });
});
