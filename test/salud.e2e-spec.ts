import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { crearApp } from './utils/crear-app';

describe('GET /flights/v1/health', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await crearApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('responde 200 con la base arriba', async () => {
    const respuesta = await request(app.getHttpServer()).get('/flights/v1/health').expect(200);

    expect(respuesta.body).toMatchObject({ status: 'UP', database: 'UP' });
    expect(new Date(respuesta.body.timestamp).toISOString()).toBe(respuesta.body.timestamp);
  });
});
