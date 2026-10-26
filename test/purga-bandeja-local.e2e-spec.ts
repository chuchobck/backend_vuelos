import { INestApplication } from '@nestjs/common';
import { BandejaEventosRepository } from '../src/modules/vuelos/operaciones/webhook/bandeja-eventos.repository';
import { PurgaBandeja } from '../src/modules/vuelos/operaciones/webhook/purga-bandeja';
import { RelevoEventos } from '../src/modules/vuelos/operaciones/webhook/relevo-eventos';

/** WEBHOOKS_MODE=local: la bandeja no se usa, así que ni el relevo ni la purga se registran. */
describe('PurgaBandeja en WEBHOOKS_MODE=local', () => {
  let app: INestApplication;
  const anterior = process.env.WEBHOOKS_MODE;

  beforeAll(async () => {
    process.env.WEBHOOKS_MODE = 'local';
    // Con valores que en notifier no arrancarían: en local no se leen
    process.env.EVENT_OUTBOX_RETENTION_DAYS = '0';
    const { crearApp } = await import('./utils/crear-app');
    app = await crearApp();
  });

  afterAll(async () => {
    await app?.close();
    if (anterior === undefined) delete process.env.WEBHOOKS_MODE;
    else process.env.WEBHOOKS_MODE = anterior;
    delete process.env.EVENT_OUTBOX_RETENTION_DAYS;
  });

  it('el job no está registrado, ni el relevo', () => {
    expect(() => app.get(PurgaBandeja, { strict: false })).toThrow();
    expect(() => app.get(RelevoEventos, { strict: false })).toThrow();
  });

  it('el repositorio de la bandeja sí existe (el publicador lo recibe en los dos modos)', () => {
    expect(app.get(BandejaEventosRepository, { strict: false })).toBeDefined();
  });
});
