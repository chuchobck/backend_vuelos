import { Controller, Get, INestApplication, UnauthorizedException } from '@nestjs/common';
import * as request from 'supertest';
import { CodigoError } from '../src/common/errores/codigo-error';
import { ErrorNegocio } from '../src/common/errores/error-negocio';
import { crearApp } from './utils/crear-app';
import { esperarProblemDetails } from './utils/problem-details';

@Controller('prueba-errores')
class ControllerDePrueba {
  @Get('negocio')
  negocio() {
    throw new ErrorNegocio(409, CodigoError.SEAT_TAKEN, 'Seat 12A is already taken', {
      invalidParams: [{ name: 'seat', reason: 'taken' }],
    });
  }

  @Get('http')
  http() {
    throw new UnauthorizedException('Token required');
  }

  @Get('interno')
  interno() {
    throw new Error('password=secreto host=db-interna');
  }
}

describe('Errores como application/problem+json', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await crearApp([ControllerDePrueba]);
  });

  afterAll(async () => {
    await app.close();
  });

  it('una ruta que no existe responde 404', async () => {
    const respuesta = await request(app.getHttpServer()).get('/flights/v1/ruta-que-no-existe');

    expect(respuesta.status).toBe(404);
    esperarProblemDetails(respuesta);
    expect(respuesta.body.detail).toBe('Route not found: GET /flights/v1/ruta-que-no-existe');
  });

  it('fuera del prefijo /flights/v1 también responde 404 como problema', async () => {
    const respuesta = await request(app.getHttpServer()).get('/flights/v2/health');

    expect(respuesta.status).toBe(404);
    esperarProblemDetails(respuesta);
  });

  it('un método que la ruta no admite responde 405 con Allow', async () => {
    const respuesta = await request(app.getHttpServer()).post('/flights/v1/health');

    expect(respuesta.status).toBe(405);
    expect(respuesta.headers['allow']).toBe('GET');
    esperarProblemDetails(respuesta);
  });

  it('un JSON mal formado responde 400', async () => {
    const respuesta = await request(app.getHttpServer())
      .post('/flights/v1/prueba-errores/negocio')
      .set('Content-Type', 'application/json')
      .send('{"a": ');

    expect(respuesta.status).toBe(400);
    esperarProblemDetails(respuesta);
    expect(respuesta.body.detail).toBe('Malformed JSON body');
  });

  it('ErrorNegocio lleva su status, su code y sus invalidParams', async () => {
    const respuesta = await request(app.getHttpServer()).get('/flights/v1/prueba-errores/negocio');

    expect(respuesta.status).toBe(409);
    esperarProblemDetails(respuesta);
    expect(respuesta.body).toMatchObject({
      type: 'https://api.booking-hub.com/errors/seat-taken',
      title: 'Conflict',
      code: 'SEAT_TAKEN',
      detail: 'Seat 12A is already taken',
      invalidParams: [{ name: 'seat', reason: 'taken' }],
    });
  });

  it('una HttpException de Nest conserva su status y su mensaje', async () => {
    const respuesta = await request(app.getHttpServer()).get('/flights/v1/prueba-errores/http');

    expect(respuesta.status).toBe(401);
    esperarProblemDetails(respuesta);
    expect(respuesta.body.detail).toBe('Token required');
  });

  it('un error no controlado responde 500 sin detalle ni stack', async () => {
    const respuesta = await request(app.getHttpServer()).get('/flights/v1/prueba-errores/interno');

    expect(respuesta.status).toBe(500);
    esperarProblemDetails(respuesta);
    expect(respuesta.body.detail).toBeUndefined();
    expect(respuesta.text).not.toMatch(/secreto|db-interna|stack|\.ts:/);
  });
});
