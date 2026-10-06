import { Controller, Get, INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { Publico } from '../src/common/decorators/publico.decorator';

/**
 * La API con NODE_ENV=production: ningún error expone stack traces, rutas de archivos, nombres
 * de tablas ni el mensaje interno. NODE_ENV se fija antes de cargar AppModule (ConfigModule lo
 * lee al importarse), por eso crearApp se importa dentro del beforeAll.
 */

@Publico()
@Controller('prueba-produccion')
class ControllerDePrueba {
  @Get('falla')
  falla() {
    throw new Error(
      'Fallo interno en /home/acer/quinde-vuelos-api/src/x.service.ts:42 con vuelos.reserva_cabecera',
    );
  }
}

/** Una línea de stack (`at fn (archivo:10:5)`), rutas de archivos, tablas o el mensaje interno. */
const RASTROS =
  /\bat [\w.<>]+ \(|\.ts:\d|\.js:\d|\/home\/|node_modules|"stack"|vuelos\.reserva|Fallo interno|prisma/i;

describe('Errores en producción', () => {
  const anterior = process.env.NODE_ENV;
  let app: INestApplication;

  beforeAll(async () => {
    process.env.NODE_ENV = 'production';
    const { crearApp } = await import('./utils/crear-app');
    app = await crearApp([ControllerDePrueba]);
  });
  afterAll(async () => {
    await app.close();
    process.env.NODE_ENV = anterior;
  });

  it.each([
    [
      'un error no controlado (500)',
      () => request(app.getHttpServer()).get('/flights/v1/prueba-produccion/falla'),
    ],
    [
      'una ruta que no existe (404)',
      () => request(app.getHttpServer()).get('/flights/v1/no/existe'),
    ],
    [
      'un método no permitido (405)',
      () => request(app.getHttpServer()).delete('/flights/v1/search'),
    ],
    [
      'un JSON roto (400)',
      () =>
        request(app.getHttpServer())
          .post('/flights/v1/search')
          .set('Content-Type', 'application/json')
          .set('X-Device-Fingerprint', 'produccion-0001')
          .send('{"itineraries": [}'),
    ],
    [
      'un cuerpo inválido (400)',
      () =>
        request(app.getHttpServer())
          .post('/flights/v1/search')
          .set('X-Device-Fingerprint', 'produccion-0001')
          .send({ itineraries: 'x' }),
    ],
    ['sin token (401)', () => request(app.getHttpServer()).get('/flights/v1/bookings')],
    [
      'sin token y con un id con comillas (401)',
      () => request(app.getHttpServer()).get('/flights/v1/bookings/1%27%20OR%201=1'),
    ],
    [
      'un cuerpo de otro tipo (415)',
      () =>
        request(app.getHttpServer())
          .post('/flights/v1/search')
          .set('Content-Type', 'text/plain')
          .send('hola'),
    ],
  ])('%s: ProblemDetails sin rastros internos', async (_caso, hacer) => {
    const respuesta = await hacer();
    expect(respuesta.status).toBeGreaterThanOrEqual(400);
    expect(respuesta.type).toBe('application/problem+json');
    expect(respuesta.text).not.toMatch(RASTROS);
  });

  it('el 500 dice solo que hubo un error interno', async () => {
    const respuesta = await request(app.getHttpServer()).get('/flights/v1/prueba-produccion/falla');
    expect(respuesta.status).toBe(500);
    expect(Object.keys(respuesta.body).sort()).toEqual(['code', 'status', 'title', 'type']);
  });

  it('en producción la CSP pide upgrade-insecure-requests', async () => {
    const respuesta = await request(app.getHttpServer()).get('/flights/v1/health');
    expect(respuesta.headers['content-security-policy']).toContain('upgrade-insecure-requests');
  });
});
