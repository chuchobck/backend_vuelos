import { INestApplication } from '@nestjs/common';
import { StockBookingWorker } from '../src/modules/vuelos/stock-booking/stock-booking.worker';
import { PrismaService } from '../src/prisma/prisma.service';
import { BookingFalso } from './utils/booking-falso';
import { desactivarUsuariosDePrueba } from './utils/auth';
import { crearCadena, darDeBajaCadena } from './utils/busqueda';
import { AppCatalogo, crearAppCatalogo } from './utils/catalogo';
import { LimitesReiniciables } from './utils/limites';
import { buscarYRetener, con, HOLD, nuevoCliente } from './utils/reserva';
import { RelojDePrueba } from './utils/reloj';

/**
 * Con BOOKING_STOCK_ENABLED=false (el valor por defecto) el empuje de stock no existe: ninguna
 * operación que mueve el cupo escribe una orden, no hay trabajador ni cliente y no se hace ni una
 * llamada a Booking, aunque la URL y el service_id estén puestos.
 */
describe('Empuje de stock a Booking apagado', () => {
  const reloj = new RelojDePrueba();
  const limites = new LimitesReiniciables();
  const entornoAnterior: Record<string, string | undefined> = {};
  let falso: BookingFalso;
  let c: AppCatalogo;
  let prisma: PrismaService;
  let app: INestApplication;

  const ordenes = async (): Promise<number> => {
    const [f] = await prisma.db.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM vuelos.orden_stock_booking`;
    return f.n;
  };

  beforeAll(async () => {
    falso = await BookingFalso.crear();
    const entorno: Record<string, string | undefined> = {
      BOOKING_STOCK_ENABLED: undefined, // el valor por defecto
      BOOKING_STOCK_URL: falso.url,
      BOOKING_STOCK_SERVICE_ID: 'quinde-e2e',
    };
    for (const [nombre, valor] of Object.entries(entorno)) {
      entornoAnterior[nombre] = process.env[nombre];
      if (valor === undefined) delete process.env[nombre];
      else process.env[nombre] = valor;
    }
    c = await crearAppCatalogo({ reloj, limites });
    app = c.app;
    prisma = c.prisma;
  });

  afterAll(async () => {
    await desactivarUsuariosDePrueba(app);
    await c.cerrar();
    await falso.caer();
    for (const [nombre, valor] of Object.entries(entornoAnterior)) {
      if (valor === undefined) delete process.env[nombre];
      else process.env[nombre] = valor;
    }
  });

  it('no hay trabajador, y crear una salida, retener y liberar no dejan ninguna orden ni llaman a Booking', async () => {
    expect(() => app.get(StockBookingWorker, { strict: false })).toThrow();
    const antes = await ordenes();

    const k = await crearCadena(c); // crea la salida y sus cupos
    const cliente = await nuevoCliente(app);
    const retenido = await buscarYRetener(app, cliente.token, [[k.origen, k.destino, k.fecha]], {
      adults: 1,
    });
    await con(app, cliente.token)('delete', `${HOLD}/${retenido.holdId}`).expect(204);
    await darDeBajaCadena(c, k);

    expect(await ordenes()).toBe(antes);
    expect(falso.recibidas).toHaveLength(0);
  });
});
