import { INestApplication } from '@nestjs/common';
import { StockBookingWorker } from '../src/modules/vuelos/stock-booking/stock-booking.worker';
import { PrismaService } from '../src/prisma/prisma.service';
import { BookingFalso } from './utils/booking-falso';
import { RelojDePrueba } from './utils/reloj';

/**
 * BOOKING_STOCK_SYNC_AL_ARRANCAR=true: al arrancar se registra una orden por cada (salida, cabina)
 * de la ventana (BOOKING_STOCK_DIAS) y el trabajador las manda. Las variables se fijan antes de
 * cargar AppModule (ConditionalModule decide al importarlo).
 */
describe('Sincronización al arrancar', () => {
  const reloj = new RelojDePrueba();
  const entornoAnterior: Record<string, string | undefined> = {};
  let falso: BookingFalso;
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    falso = await BookingFalso.crear();
    const entorno = {
      BOOKING_STOCK_ENABLED: 'true',
      BOOKING_STOCK_URL: falso.url,
      BOOKING_STOCK_SERVICE_ID: 'quinde-e2e',
      BOOKING_STOCK_DIAS: '1',
      BOOKING_STOCK_SYNC_AL_ARRANCAR: 'true',
      BOOKING_STOCK_JOB_ENABLED: 'false',
    };
    for (const [nombre, valor] of Object.entries(entorno)) {
      entornoAnterior[nombre] = process.env[nombre];
      process.env[nombre] = valor;
    }
  });

  afterAll(async () => {
    await app?.close();
    await falso.caer();
    for (const [nombre, valor] of Object.entries(entornoAnterior)) {
      if (valor === undefined) delete process.env[nombre];
      else process.env[nombre] = valor;
    }
  });

  it('registra la ventana al arrancar y el trabajador la manda con los campos del contrato', async () => {
    // Las órdenes llevan la hora del Reloj (el de la prueba está quieto), no la de la máquina
    const inicio = reloj.ahora();
    const { crearApp } = await import('./utils/crear-app');
    app = await crearApp([], { reloj });
    prisma = app.get(PrismaService);

    const registradas = async () => {
      const [f] = await prisma.db.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM vuelos.orden_stock_booking
         WHERE solicitado_en >= ${inicio}::timestamptz AND correlation_id LIKE 'corr-%'`;
      return f.n;
    };
    // El registro corre sin bloquear el arranque: se espera a que termine
    let n = 0;
    for (let i = 0; i < 100 && n === 0; i++) {
      await new Promise((listo) => setTimeout(listo, 100));
      n = await registradas();
    }
    expect(n).toBeGreaterThan(50);

    const worker = app.get(StockBookingWorker);
    for (let i = 0; i < 40; i++) {
      const r = await worker.ejecutar();
      if (Object.values(r).every((x) => x === 0)) break;
    }
    expect(falso.recibidas.length).toBeGreaterThanOrEqual(n);
    for (const r of falso.recibidas) {
      expect(r.registro).toMatchObject({ service_id: 'quinde-e2e' });
      expect(r.registro.time_slot).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
    }
  }, 60_000);
});
