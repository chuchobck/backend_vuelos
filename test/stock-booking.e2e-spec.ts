import { ConfigService } from '@nestjs/config';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { validarEntorno } from '../src/config/entorno';
import { configuracionStockBooking } from '../src/config/stock-booking';
import { Observabilidad } from '../src/observabilidad/observabilidad';
import { VencimientoRetenciones } from '../src/modules/vuelos/operaciones/retencion/vencimiento-retenciones';
import {
  ClienteStockBooking,
  resumir,
} from '../src/modules/vuelos/stock-booking/cliente-stock-booking';
import {
  CortaCircuito,
  REGLAS_CORTACIRCUITO,
} from '../src/modules/vuelos/stock-booking/corta-circuito';
import { itemId, timeSlot } from '../src/modules/vuelos/stock-booking/item-stock';
import { SincronizadorStock } from '../src/modules/vuelos/stock-booking/sincronizador-stock';
import { StockBookingRepository } from '../src/modules/vuelos/stock-booking/stock-booking.repository';
import {
  esperaTras,
  REGLAS_STOCK,
  StockBookingWorker,
} from '../src/modules/vuelos/stock-booking/stock-booking.worker';
import { BookingFalso } from './utils/booking-falso';
import type { CadenaBusqueda } from './utils/busqueda';
import type { AppCatalogo } from './utils/catalogo';
import { LimitesReiniciables } from './utils/limites';
import { LogEnMemoria } from './utils/log-en-memoria';
import { RelojDePrueba } from './utils/reloj';

const exec = promisify(execFile);
const RAIZ = resolve(__dirname, '..');
const SCRIPT = join(RAIZ, 'scripts', 'sincronizar-stock.cjs');
const SERVICE_ID = 'quinde-e2e';
const RUTA = '/api/v2/inventory/stock';
const MINUTO = 60_000;

/**
 * El empuje de stock a Booking (BOOKING_STOCK_ENABLED=true) contra un Booking FALSO en el propio
 * test: cada operación que cambia el cupo deja su orden en la misma transacción y el trabajador
 * manda el valor absoluto actual. No se llama al Booking real.
 */

describe('Campos del contrato de Booking', () => {
  it('item_id es <número de vuelo>-<CABINA DEL CONTRATO>', () => {
    expect(itemId('AV1632', 'ECONOMICA')).toBe('AV1632-ECONOMY');
    expect(itemId('LA1400', 'ECONOMICA_PREMIUM')).toBe('LA1400-PREMIUM_ECONOMY');
    expect(itemId('LA1400', 'EJECUTIVA')).toBe('LA1400-BUSINESS');
    expect(itemId('LA1400', 'PRIMERA')).toBe('LA1400-FIRST');
  });

  it('time_slot es la hora local de salida (HH:mm) en la zona del origen, Galápagos una hora detrás', () => {
    const salida = new Date('2026-11-02T13:30:00.000Z');
    expect(timeSlot(salida, 'America/Guayaquil')).toBe('08:30');
    expect(timeSlot(salida, 'Pacific/Galapagos')).toBe('07:30');
    expect(timeSlot(new Date('2026-11-02T05:05:00.000Z'), 'America/Guayaquil')).toBe('00:05');
  });

  it('el plazo por defecto es de 5 s, la ventana de 90 días y el service_id no tiene valor por defecto', () => {
    const config = new ConfigService({ BOOKING_STOCK_SERVICE_ID: 'quinde-x' });
    expect(configuracionStockBooking(config)).toMatchObject({
      plazoMs: 5000,
      dias: 90,
      serviceId: 'quinde-x',
      url: 'https://booking-core-api.azurewebsites.net/api/v2/inventory/stock',
    });
    expect(() => configuracionStockBooking(new ConfigService({}))).toThrow();
  });

  describe('validación del entorno', () => {
    const base = {
      DATABASE_URL: 'postgresql://u@localhost:5432/booking_db',
      PORT: '3000',
      NODE_ENV: 'production',
      JWT_SECRET: 'j'.repeat(40),
      WEBHOOK_SECRET_KEY: 'w'.repeat(40),
    };
    const errorCon = (variables: Record<string, string>): string => {
      try {
        validarEntorno({ ...base, ...variables });
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error('validarEntorno aceptó la configuración');
    };

    it('apagado no se pide nada, ni se lee lo que haya puesto', () => {
      expect(() => validarEntorno(base)).not.toThrow();
      expect(() =>
        validarEntorno({ ...base, BOOKING_STOCK_DIAS: '0', BOOKING_STOCK_SERVICE_ID: 'vuelos' }),
      ).not.toThrow();
    });

    it('activo exige el service_id (sin valor por defecto) y nunca "vuelos"', () => {
      const activo = { BOOKING_STOCK_ENABLED: 'true' };
      expect(errorCon(activo)).toContain('BOOKING_STOCK_SERVICE_ID es obligatoria');
      for (const malo of ['vuelos', 'Vuelos', 'VUELOS', 'con espacio', 'ab']) {
        const mensaje = errorCon({ ...activo, BOOKING_STOCK_SERVICE_ID: malo });
        expect(mensaje).toContain('BOOKING_STOCK_SERVICE_ID');
        if (malo === 'con espacio') expect(mensaje).not.toContain(malo); // nombra la variable, no el valor
      }
      expect(() =>
        validarEntorno({ ...base, ...activo, BOOKING_STOCK_SERVICE_ID: 'quinde-vuelos' }),
      ).not.toThrow();
    });

    it.each([
      ['BOOKING_STOCK_TIMEOUT_MS', '50'],
      ['BOOKING_STOCK_TIMEOUT_MS', '99999'],
      ['BOOKING_STOCK_DIAS', '0'],
      ['BOOKING_STOCK_DIAS', '400'],
      ['BOOKING_STOCK_SYNC_AL_ARRANCAR', 'quizas'],
      ['BOOKING_STOCK_JOB_INTERVAL_SECONDS', '0'],
      ['BOOKING_STOCK_URL', 'ftp://booking.example/stock'],
    ])('activo, %s=%s da un error que nombra la variable y no repite el valor', (nombre, valor) => {
      const mensaje = errorCon({
        BOOKING_STOCK_ENABLED: 'true',
        BOOKING_STOCK_SERVICE_ID: 'quinde-vuelos',
        [nombre]: valor,
      });
      expect(mensaje).toContain(nombre);
      if (valor.length > 2) expect(mensaje).not.toContain(valor);
    });
  });

  it('las esperas crecen y se quedan en una hora', () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(esperaTras)).toEqual([5, 30, 120, 600, 1800, 3600, 3600]);
    expect(REGLAS_STOCK.maximoIntentos).toBe(10);
  });

  it('el resumen de un rechazo es corto y sin saltos de línea ni caracteres raros', () => {
    expect(resumir({ message: 'item_id\ndesconocido <script>' })).toBe(
      'item_id?desconocido ?script?',
    );
    expect(resumir({ message: 'x'.repeat(500) })).toHaveLength(120);
    expect(resumir({ otro: 'nada' })).toBeNull();
    expect(resumir(undefined)).toBeNull();
  });
});

describe('Cortacircuitos', () => {
  const t0 = new Date('2026-11-02T10:00:00.000Z');
  const despues = (ms: number) => new Date(t0.getTime() + ms);

  it('se abre con 5 fallos seguidos, deja pasar UNA prueba al vencer y se cierra si sale bien', () => {
    const c = new CortaCircuito();
    for (let i = 0; i < REGLAS_CORTACIRCUITO.fallosParaAbrir - 1; i++) c.fallo(t0);
    expect(c.permite(t0)).toBe(true);
    c.fallo(t0);
    expect(c.abierto).toBe(true);
    expect(c.permite(despues(1000))).toBe(false);
    expect(c.permite(despues(REGLAS_CORTACIRCUITO.aperturaInicialMs))).toBe(true);
    expect(c.permite(despues(REGLAS_CORTACIRCUITO.aperturaInicialMs))).toBe(false); // solo una prueba
    c.exito();
    expect(c.abierto).toBe(false);
    expect(c.permite(t0)).toBe(true);
  });

  it('si la prueba falla se abre otra vez con el doble de espera, hasta un tope', () => {
    const c = new CortaCircuito();
    for (let i = 0; i < REGLAS_CORTACIRCUITO.fallosParaAbrir; i++) c.fallo(t0);
    let ahora = despues(REGLAS_CORTACIRCUITO.aperturaInicialMs);
    expect(c.permite(ahora)).toBe(true);
    c.fallo(ahora);
    expect(c.reabreEn?.getTime()).toBe(
      ahora.getTime() + 2 * REGLAS_CORTACIRCUITO.aperturaInicialMs,
    );
    for (let i = 0; i < 10; i++) {
      ahora = new Date(c.reabreEn!.getTime());
      expect(c.permite(ahora)).toBe(true);
      c.fallo(ahora);
    }
    expect(c.reabreEn!.getTime() - ahora.getTime()).toBe(REGLAS_CORTACIRCUITO.aperturaMaximaMs);
  });

  it('un éxito en medio pone la cuenta en cero', () => {
    const c = new CortaCircuito();
    for (let i = 0; i < 4; i++) c.fallo(t0);
    c.exito();
    for (let i = 0; i < 4; i++) c.fallo(t0);
    expect(c.abierto).toBe(false);
  });
});

type Utilidades = typeof import('./utils/reserva') &
  typeof import('./utils/busqueda') &
  typeof import('./utils/catalogo') &
  typeof import('./utils/postventa') &
  typeof import('./utils/auth') &
  typeof import('./utils/crear-app');

describe('Empuje de stock a Booking', () => {
  // AppModule decide con ConditionalModule al importarse: los utilitarios se cargan DESPUÉS de fijar el entorno
  let u: Utilidades;
  let registradasAlArrancar = -1;
  const reloj = new RelojDePrueba();
  const limites = new LimitesReiniciables();
  const log = new LogEnMemoria();
  const entornoAnterior: Record<string, string | undefined> = {};
  let falso: BookingFalso;
  let c: AppCatalogo;
  let k: CadenaBusqueda;
  let nueva: { salida: string; fecha: string };
  let worker: StockBookingWorker;
  let cliente: ClienteStockBooking;
  let duena: { id: string; token: string };
  const holds: string[] = [];

  const ENTORNO = (url: string): Record<string, string> => ({
    BOOKING_STOCK_ENABLED: 'true',
    BOOKING_STOCK_URL: url,
    BOOKING_STOCK_SERVICE_ID: SERVICE_ID,
    BOOKING_STOCK_TIMEOUT_MS: '400',
    BOOKING_STOCK_JOB_ENABLED: 'false',
    BOOKING_STOCK_SYNC_AL_ARRANCAR: 'false',
  });

  const prefijo = () => `${k.vuelo}-`;
  const economy = () => falso.de(prefijo()).filter((r) => r.registro.item_id.endsWith('-ECONOMY'));
  const unidades = () => economy().map((r) => r.registro.available_units);

  /** Corre el trabajador hasta que no quede nada por tomar (lo que espera un reintento no se toma). */
  const drenar = async () => {
    for (let i = 0; i < 40; i++) {
      const r = await worker.ejecutar();
      if (Object.values(r).every((n) => n === 0)) return;
    }
  };

  const disponibles = async (salida: string, cabina = 'ECONOMICA') => {
    const [f] = await c.prisma.db.$queryRaw<Array<{ n: number }>>`
      SELECT cupos_disponibles::int AS n FROM vuelos.inventario_cabina
       WHERE vuelo_programado_id = ${salida}::uuid AND clase_cabina::text = ${cabina}`;
    return f.n;
  };

  const orden = async (salida: string, cabina = 'ECONOMICA') => {
    const [f] = await c.prisma.db.$queryRaw<
      Array<{
        estado: string;
        version: number;
        intentos: number;
        error: string | null;
        codigo: number | null;
        unidades: number | null;
        proximo: Date;
        corr: string | null;
        lease: Date | null;
      }>
    >`
      SELECT estado::text AS estado, version::int AS version, intentos::int AS intentos,
             ultimo_error AS error, ultimo_codigo_http::int AS codigo,
             unidades_enviadas::int AS unidades, proximo_intento AS proximo,
             correlation_id AS corr, arrendamiento_hasta AS lease
        FROM vuelos.orden_stock_booking
       WHERE vuelo_programado_id = ${salida}::uuid AND clase_cabina::text = ${cabina}`;
    return f;
  };

  /** Busca y retiene un adulto en la cadena (el hold se libera al terminar la prueba). */
  const retener = async () => {
    const r = await u.buscarYRetener(c.app, duena.token, [[k.origen, k.destino, k.fecha]], {
      adults: 1,
    });
    holds.push(r.holdId);
    return r;
  };
  const liberar = (holdId: string) =>
    u.con(c.app, duena.token)('delete', `${u.HOLD}/${holdId}`).expect(204);

  beforeAll(async () => {
    falso = await BookingFalso.crear();
    for (const [nombre, valor] of Object.entries(ENTORNO(falso.url))) {
      entornoAnterior[nombre] = process.env[nombre];
      process.env[nombre] = valor;
    }
    const [reserva, busqueda, catalogo, postventa, auth, crear] = await Promise.all([
      import('./utils/reserva'),
      import('./utils/busqueda'),
      import('./utils/catalogo'),
      import('./utils/postventa'),
      import('./utils/auth'),
      import('./utils/crear-app'),
    ]);
    u = { ...reserva, ...busqueda, ...catalogo, ...postventa, ...auth, ...crear };
    // Las órdenes llevan la hora del Reloj (el de la prueba está quieto), no la de la máquina
    const inicioDeLaSuite = reloj.ahora();
    c = await u.crearAppCatalogo({ reloj, limites });
    c.app.useLogger(log);
    // Sin BOOKING_STOCK_SYNC_AL_ARRANCAR el arranque no registra nada: se espera a que lo haría
    await new Promise((listo) => setTimeout(listo, 500));
    [{ n: registradasAlArrancar }] = await c.prisma.db.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM vuelos.orden_stock_booking
       WHERE solicitado_en >= ${inicioDeLaSuite}::timestamptz`;
    worker = c.app.get(StockBookingWorker);
    cliente = c.app.get(ClienteStockBooking);
    k = await u.crearCadena(c);
    await c
      .admin('patch', `${u.ADMIN}/airlines/${k.aerolinea}`, {
        ticketPrefix: await u.codigos.prefijoBoleto(c.prisma),
      })
      .expect(200);
    await c
      .admin('patch', `${u.ADMIN}/fare-families/${k.familia}`, {
        changeable: true,
        cancellationPenaltyPercent: '50',
      })
      .expect(200);
    // 6 cupos de económica: el alta (2) y este ajuste (6) se juntan en UNA orden
    await c
      .admin('patch', `${u.ADMIN}/departures/${k.salida}`, {
        cabins: [{ cabinClass: 'ECONOMY', totalSeats: 6 }],
      })
      .expect(200);
    nueva = await u.agregarSalida(c, k, 22, 6, { baseFare: '70.00', taxes: '14.00' });
    duena = await u.nuevoCliente(c.app);
  });

  beforeEach(async () => {
    reloj.alPresente();
    limites.reiniciar();
    falso.reiniciar();
    cliente.cortacircuito.exito();
    await drenar(); // lo que dejó la prueba anterior
    falso.reiniciar();
  });

  afterEach(async () => {
    reloj.alPresente();
    for (const id of holds.splice(0)) {
      await u.con(c.app, duena.token)('delete', `${u.HOLD}/${id}`);
    }
  });

  afterAll(async () => {
    await u.cancelarReservasDe(c.app, duena.token);
    for (const id of holds.splice(0)) await u.con(c.app, duena.token)('delete', `${u.HOLD}/${id}`);
    await c.admin('delete', `${u.ADMIN}/departures/${nueva.salida}`);
    await c.admin('patch', `${u.ADMIN}/airlines/${k.aerolinea}`, { ticketPrefix: null });
    await u.darDeBajaCadena(c, k);
    reloj.alPresente();
    cliente.cortacircuito.exito();
    falso.reiniciar();
    await drenar();
    await u.desactivarUsuariosDePrueba(c.app);
    await c.cerrar();
    await falso.caer();
    for (const [nombre, valor] of Object.entries(entornoAnterior)) {
      if (valor === undefined) delete process.env[nombre];
      else process.env[nombre] = valor;
    }
  });

  it('sin BOOKING_STOCK_SYNC_AL_ARRANCAR el arranque no registra ninguna orden', () => {
    expect(registradasAlArrancar).toBe(0);
  });

  describe('qué se manda', () => {
    it('el alta y el ajuste de una salida se juntan en una orden por cabina, con los campos del contrato', async () => {
      // Una salida propia: se crea (2 cupos y 0 de ejecutiva) y se ajusta (5) antes de mandar nada
      const extra = await u.agregarSalida(c, k, 23, 2, { baseFare: '60.00', taxes: '12.00' });
      await c
        .admin('patch', `${u.ADMIN}/departures/${extra.salida}`, {
          cabins: [{ cabinClass: 'ECONOMY', totalSeats: 5 }],
        })
        .expect(200);
      await drenar();

      const recibidas = falso.de(prefijo()).filter((r) => r.registro.date === extra.fecha);
      expect(recibidas.map((r) => r.registro.item_id).sort()).toEqual(
        [`${k.vuelo}-BUSINESS`, `${k.vuelo}-ECONOMY`].sort(),
      ); // una sola por cabina: el alta y el ajuste se juntaron
      const eco = recibidas.find((r) => r.registro.item_id.endsWith('-ECONOMY'))!;
      expect(eco.registro).toEqual({
        service_id: SERVICE_ID,
        item_id: `${k.vuelo}-ECONOMY`,
        date: extra.fecha,
        time_slot: '10:00', // 15:00 UTC en Ecuador continental
        available_units: 5,
      });
      expect(
        recibidas.find((r) => r.registro.item_id.endsWith('-BUSINESS'))!.registro,
      ).toMatchObject({ available_units: 0, date: extra.fecha, time_slot: '10:00' });
      expect(eco).toMatchObject({ metodo: 'POST', ruta: RUTA, contentType: 'application/json' });
      // Sin cabecera de autenticación documentada: no se manda ninguna; y nada de traza hacia un tercero
      expect(eco.autorizacion).toBeUndefined();
      expect(eco.traceparent).toBeUndefined();
      expect(eco.correlacion).toMatch(/^corr-[0-9a-f-]{36}$/);
      expect(await orden(extra.salida)).toMatchObject({
        estado: 'ENVIADO',
        unidades: 5,
        error: null,
        corr: eco.correlacion,
      });
      await c.admin('delete', `${u.ADMIN}/departures/${extra.salida}`).expect(204);
    });

    it('crear una salida manda sus cabinas sin que nadie la toque después', async () => {
      const creada = await u.agregarSalida(c, k, 24, 3, { baseFare: '55.00', taxes: '11.00' });
      await drenar();
      const deEsta = falso.de(prefijo()).filter((r) => r.registro.date === creada.fecha);
      expect(deEsta.map((r) => [r.registro.item_id, r.registro.available_units]).sort()).toEqual(
        [
          [`${k.vuelo}-BUSINESS`, 0],
          [`${k.vuelo}-ECONOMY`, 3],
        ].sort(),
      );
      await c.admin('delete', `${u.ADMIN}/departures/${creada.salida}`).expect(204);
    });

    it('crear un hold manda el cupo absoluto que queda', async () => {
      const antes = await disponibles(k.salida);
      await retener();
      await drenar();
      expect(unidades()).toEqual([antes - 1]);
      expect(unidades()[0]).toBe(await disponibles(k.salida));
    });

    it('varios cambios antes de mandar se juntan en UN envío con el valor de ese momento, no con la suma de deltas', async () => {
      const antes = await disponibles(k.salida);
      const a = await retener();
      await liberar(a.holdId);
      await retener();
      const versionAntes = (await orden(k.salida)).version;
      expect(versionAntes).toBeGreaterThanOrEqual(3);
      await drenar();
      expect(economy()).toHaveLength(1);
      expect(unidades()).toEqual([antes - 1]);
    });

    it('liberar un hold devuelve el cupo y se refleja', async () => {
      const antes = await disponibles(k.salida);
      const h = await retener();
      await drenar();
      expect(unidades()).toEqual([antes - 1]);
      await liberar(h.holdId);
      await drenar();
      expect(unidades()).toEqual([antes - 1, antes]);
    });

    it('un hold que vence por el proceso periódico devuelve el cupo y se refleja', async () => {
      const antes = await disponibles(k.salida);
      await retener();
      await drenar();
      expect(unidades()).toEqual([antes - 1]);
      reloj.adelantar(16);
      await c.app.get(VencimientoRetenciones).ejecutar();
      await drenar();
      expect(unidades().at(-1)).toBe(antes);
      expect(unidades().at(-1)).toBe(await disponibles(k.salida));
    });

    it('reservar consume el hold sin mover el cupo (no manda nada); cancelar la reserva lo devuelve', async () => {
      const antes = await disponibles(k.salida);
      const h = await retener();
      await drenar();
      expect(unidades()).toEqual([antes - 1]);
      holds.pop();
      await u
        .reservar(
          c.app,
          duena.token,
          u.cuerpoReserva(h.holdId, [u.pasajero('ADULT', 1)], u.referenciaPago()),
        )
        .expect(201);
      await drenar();
      expect(unidades()).toEqual([antes - 1]); // nada nuevo
      expect(await u.cancelarReservasDe(c.app, duena.token)).toBeGreaterThanOrEqual(1);
      await drenar();
      expect(unidades()).toEqual([antes - 1, antes]);
    });

    it('el cambio de fecha mueve el cupo: +1 en la salida vieja y −1 en la nueva', async () => {
      const h = await u.buscarYRetener(c.app, duena.token, [[k.origen, k.destino, k.fecha]], {
        adults: 1,
      });
      holds.pop();
      const reserva = await u
        .reservar(
          c.app,
          duena.token,
          u.cuerpoReserva(h.holdId, [u.pasajero('ADULT', 1)], u.referenciaPago()),
        )
        .expect(201);
      await drenar();
      falso.reiniciar();
      const viejaAntes = await disponibles(k.salida);
      const nuevaAntes = await disponibles(nueva.salida);

      const itinerario = h.oferta.itineraries[0].itineraryId;
      const busqueda = await u
        .con(c.app, duena.token)(
          'post',
          `${u.RESERVAS}/${reserva.body.bookingId}/date-change/search`,
        )
        .send({ changes: [{ itineraryId: itinerario, newDepartureDate: nueva.fecha }] })
        .expect(200);
      await u
        .con(c.app, duena.token)('post', `${u.RESERVAS}/${reserva.body.bookingId}/date-change`)
        .set('Idempotency-Key', randomUUID())
        .send({
          changeOfferId: busqueda.body[0].changeOfferId,
          payment: { paymentReference: u.referenciaPago() },
          assignedSeats: [{ segmentId: nueva.salida, seatNumber: '3C' }],
        })
        .expect(200);
      await drenar();

      const de = (id: string) =>
        falso
          .de(prefijo())
          .filter((r) => r.registro.item_id.endsWith('-ECONOMY'))
          .filter((r) => r.registro.date === id);
      expect(de(k.fecha).at(-1)?.registro.available_units).toBe(viejaAntes + 1);
      expect(de(nueva.fecha).at(-1)?.registro.available_units).toBe(nuevaAntes - 1);
      expect(viejaAntes + 1).toBe(await disponibles(k.salida));
      expect(nuevaAntes - 1).toBe(await disponibles(nueva.salida));
    });

    it('el catálogo: ajustar el cupo, cambiar la hora y cancelar o reactivar la salida', async () => {
      // La reserva que dejó el cambio de fecha vive en esta salida: se cancela para poder cancelarla
      await u.cancelarReservasDe(c.app, duena.token);
      await drenar();
      falso.reiniciar();
      // Ajustar el total de la salida nueva (6 → 4): los disponibles bajan lo mismo, lo ya vendido sigue vendido
      const antesNueva = await disponibles(nueva.salida);
      await c
        .admin('patch', `${u.ADMIN}/departures/${nueva.salida}`, {
          cabins: [{ cabinClass: 'ECONOMY', totalSeats: 4 }],
        })
        .expect(200);
      await drenar();
      const deNueva = () => falso.de(prefijo()).filter((r) => r.registro.date === nueva.fecha);
      expect(
        deNueva().find((r) => r.registro.item_id === `${k.vuelo}-ECONOMY`)?.registro,
      ).toMatchObject({ available_units: antesNueva - 2 });

      // La hora de salida: 16:00 UTC son las 11:00 en Ecuador
      falso.reiniciar();
      await c
        .admin('patch', `${u.ADMIN}/departures/${nueva.salida}`, {
          scheduledDeparture: u.enDias(22, 16),
          scheduledArrival: u.enDias(22, 17),
        })
        .expect(200);
      await drenar();
      expect(deNueva().map((r) => r.registro.time_slot)).toEqual(['11:00', '11:00']);

      // Cancelar la salida: lo que se vende es 0
      falso.reiniciar();
      await c.admin('delete', `${u.ADMIN}/departures/${nueva.salida}`).expect(204);
      await drenar();
      expect(deNueva().map((r) => r.registro.available_units)).toEqual([0, 0]);

      // Reactivarla: vuelve el cupo
      falso.reiniciar();
      await c.admin('post', `${u.ADMIN}/departures/${nueva.salida}/reactivate`).expect(200);
      await drenar();
      const eco = deNueva().find((r) => r.registro.item_id.endsWith('-ECONOMY'));
      expect(eco?.registro.available_units).toBe(await disponibles(nueva.salida));
      expect(eco?.registro.available_units).toBeGreaterThan(0);
    });

    it('agregar a una salida una cabina que no tenía manda esa cabina', async () => {
      const creada = await c
        .admin('post', `${u.ADMIN}/departures`, {
          flightNumber: k.vuelo,
          seatMapId: k.mapa,
          scheduledDeparture: u.enDias(26, 15),
          scheduledArrival: u.enDias(26, 16),
          cabins: [{ cabinClass: 'ECONOMY', totalSeats: 3 }],
        })
        .expect(201);
      const deEsta = () =>
        falso.de(prefijo()).filter((r) => r.registro.date === creada.body.departureDate);
      await drenar();
      expect(deEsta().map((r) => r.registro.item_id)).toEqual([`${k.vuelo}-ECONOMY`]);

      falso.reiniciar();
      await c
        .admin('patch', `${u.ADMIN}/departures/${creada.body.id}`, {
          cabins: [{ cabinClass: 'BUSINESS', totalSeats: 2 }],
        })
        .expect(200);
      await drenar();
      expect(
        deEsta().find((r) => r.registro.item_id === `${k.vuelo}-BUSINESS`)?.registro,
      ).toMatchObject({ available_units: 2, date: creada.body.departureDate });
      await c.admin('delete', `${u.ADMIN}/departures/${creada.body.id}`).expect(204);
    });

    it('si llega un cambio mientras un envío está en vuelo, esa orden no se da por mandada y se manda el valor nuevo', async () => {
      const antes = await disponibles(k.salida);
      await retener(); // orden pendiente: valor antes − 1
      let segundo: string | undefined;
      falso.alRecibir = async () => {
        falso.alRecibir = undefined;
        segundo = (await retener()).holdId; // mientras el primero está en vuelo
      };
      await worker.ejecutar();
      expect(segundo).toBeDefined();
      // El primer envío (antes − 1) no se dio por mandado: la misma corrida mandó después antes − 2
      expect(unidades()).toEqual([antes - 1, antes - 2]);
      expect(await orden(k.salida)).toMatchObject({ estado: 'ENVIADO', unidades: antes - 2 });
      expect(log.texto()).toContain('SUPERADA');
    });
  });

  describe('el empuje sigue a la transacción del cambio', () => {
    it('un cambio de fecha que se deshace (asiento inexistente) no deja ninguna orden ni manda nada', async () => {
      const h = await u.buscarYRetener(c.app, duena.token, [[k.origen, k.destino, k.fecha]], {
        adults: 1,
      });
      await u
        .reservar(c.app, duena.token, u.cuerpoReserva(h.holdId, [u.pasajero('ADULT', 1)]))
        .expect(201);
      await drenar();
      falso.reiniciar();
      const versiones = {
        vieja: (await orden(k.salida)).version,
        nueva: (await orden(nueva.salida)).version,
      };
      const nuevaAntes = await disponibles(nueva.salida);

      const reservaId = (
        await u
          .con(c.app, duena.token)('get', `${u.RESERVAS}?status=CONFIRMED&limit=50`)
          .expect(200)
      ).body.items[0].bookingId as string;
      const busqueda = await u
        .con(c.app, duena.token)('post', `${u.RESERVAS}/${reservaId}/date-change/search`)
        .send({
          changes: [
            { itineraryId: h.oferta.itineraries[0].itineraryId, newDepartureDate: nueva.fecha },
          ],
        })
        .expect(200);
      // El asiento no existe: falla DESPUÉS de mover el cupo, y todo se deshace
      const respuesta = await u
        .con(c.app, duena.token)('post', `${u.RESERVAS}/${reservaId}/date-change`)
        .set('Idempotency-Key', randomUUID())
        .send({
          changeOfferId: busqueda.body[0].changeOfferId,
          payment: { paymentReference: u.referenciaPago() },
          assignedSeats: [{ segmentId: nueva.salida, seatNumber: '9Z' }],
        });
      expect(respuesta.status).toBeGreaterThanOrEqual(400);
      expect(await disponibles(nueva.salida)).toBe(nuevaAntes);

      await drenar();
      expect(falso.recibidas).toHaveLength(0);
      expect((await orden(k.salida)).version).toBe(versiones.vieja);
      expect((await orden(nueva.salida)).version).toBe(versiones.nueva);
      await u.cancelarReservasDe(c.app, duena.token);
    });
  });

  describe('Booking no contesta bien: la venta sigue', () => {
    it('con Booking respondiendo 503 el hold se crea igual; se reintenta con espera creciente y se recupera', async () => {
      falso.siempre({ status: 503, cuerpo: { success: false } });
      const antes = await disponibles(k.salida);
      await retener(); // 201: no depende de Booking
      expect(await disponibles(k.salida)).toBe(antes - 1);

      await drenar();
      expect(falso.de(prefijo())).toHaveLength(1);
      let o = await orden(k.salida);
      expect(o).toMatchObject({ estado: 'PENDIENTE', intentos: 1, error: 'HTTP_503', codigo: 503 });
      expect(o.proximo.getTime() - reloj.ahora().getTime()).toBe(5_000);

      // Antes de la espera no vuelve a llamar
      await drenar();
      expect(falso.de(prefijo())).toHaveLength(1);

      // Pasados 5 s, segundo intento; la espera siguiente es de 30 s
      reloj.adelantar(6 / 60);
      await drenar();
      expect(falso.de(prefijo())).toHaveLength(2);
      o = await orden(k.salida);
      expect(o.intentos).toBe(2);
      expect(o.proximo.getTime() - reloj.ahora().getTime()).toBe(30_000);

      // Booking vuelve: el siguiente intento manda el valor de ese momento y queda ENVIADO
      falso.reiniciar();
      reloj.adelantar(1);
      await drenar();
      expect(unidades()).toEqual([antes - 1]);
      expect(await orden(k.salida)).toMatchObject({
        estado: 'ENVIADO',
        error: null,
        unidades: antes - 1,
      });
    });

    it('con Booking caído (conexión rechazada) la compra no falla y el empuje se recupera cuando vuelve', async () => {
      await falso.caer();
      let levantado = false;
      try {
        const antes = await disponibles(k.salida);
        const h = await retener();
        expect(h.holdId).toBeDefined();
        await drenar();
        expect(await orden(k.salida)).toMatchObject({
          estado: 'PENDIENTE',
          intentos: 1,
          error: 'ECONNREFUSED',
          codigo: null,
        });
        await falso.levantar();
        levantado = true;
        reloj.adelantar(1);
        await drenar();
        expect(unidades()).toEqual([antes - 1]);
        expect((await orden(k.salida)).estado).toBe('ENVIADO');
      } finally {
        if (!levantado) await falso.levantar();
      }
    });

    it('un plazo agotado se reintenta y la llamada no espera más que BOOKING_STOCK_TIMEOUT_MS', async () => {
      falso.responder({ status: 200, demoraMs: 3000 });
      await retener();
      const inicio = Date.now();
      await drenar();
      expect(Date.now() - inicio).toBeLessThan(2000);
      expect(await orden(k.salida)).toMatchObject({
        estado: 'PENDIENTE',
        error: 'TIMEOUT',
        codigo: null,
      });
      reloj.adelantar(1);
      await drenar();
      expect((await orden(k.salida)).estado).toBe('ENVIADO');
    });

    it('respuesta 200 con success:false: FALLIDO sin reintento, con el motivo en el log y sin datos de más', async () => {
      falso.responder({
        status: 200,
        cuerpo: { success: false, message: 'item_id desconocido en el catálogo' },
      });
      await retener();
      await drenar();
      expect(await orden(k.salida)).toMatchObject({
        estado: 'FALLIDO',
        error: 'SUCCESS_FALSE',
        codigo: 200,
      });
      reloj.adelantar(24 * 60);
      await drenar();
      expect(falso.de(prefijo())).toHaveLength(1); // no reintentó
      expect(log.texto()).toContain('SUCCESS_FALSE');
      expect(log.texto()).toContain('item_id desconocido en el catálogo');

      // Un cambio de cupo nuevo la vuelve a mandar (el reloj vuelve a la hora real: las ofertas de
      // la búsqueda todavía vencen con la hora de la máquina, no con la del Reloj)
      falso.reiniciar();
      reloj.alPresente();
      await retener();
      await drenar();
      expect((await orden(k.salida)).estado).toBe('ENVIADO');
    });

    it.each([
      ['400', 400, 'FALLIDO'],
      ['404', 404, 'FALLIDO'],
      ['409', 409, 'FALLIDO'],
      ['422', 422, 'FALLIDO'],
    ])(
      'un %s de validación no se reintenta: FALLIDO y el cuerpo resumido en el log',
      async (_n, status, estado) => {
        falso.responder({
          status,
          cuerpo: { success: false, message: 'campo inválido: time_slot' },
        });
        await retener();
        await drenar();
        expect(await orden(k.salida)).toMatchObject({
          estado,
          error: `HTTP_${status}`,
          codigo: status,
        });
        reloj.adelantar(24 * 60);
        await drenar();
        expect(falso.de(prefijo())).toHaveLength(1);
        expect(log.texto()).toContain(`HTTP_${status}`);
        expect(log.texto()).toContain('campo inválido: time_slot');
      },
    );

    it.each([
      ['401', 401],
      ['403', 403],
      ['429', 429],
      ['500', 500],
      ['302', 302],
    ])(
      'un %s se reintenta (es de configuración o de carga, no de lo que mandamos)',
      async (_n, status) => {
        falso.responder({ status, cabeceras: status === 429 ? { 'Retry-After': '120' } : {} });
        await retener();
        await drenar();
        const o = await orden(k.salida);
        expect(o).toMatchObject({ estado: 'PENDIENTE', error: `HTTP_${status}`, intentos: 1 });
        const espera = o.proximo.getTime() - reloj.ahora().getTime();
        expect(espera).toBe(status === 429 ? 120_000 : 5_000);
      },
    );

    it('un 200 que no es JSON se reintenta', async () => {
      falso.responder({ status: 200, cuerpo: '<html>proxy</html>' });
      await retener();
      await drenar();
      expect(await orden(k.salida)).toMatchObject({
        estado: 'PENDIENTE',
        error: 'RESPUESTA_INVALIDA',
      });
    });

    it('tras 10 intentos fallidos queda FALLIDO y la sincronización la vuelve a mandar', async () => {
      falso.siempre({ status: 503, cuerpo: { success: false } });
      await retener();
      for (let i = 0; i < REGLAS_STOCK.maximoIntentos; i++) {
        await drenar();
        reloj.adelantar(120); // más que cualquier espera y que el cortacircuitos
      }
      expect(falso.de(prefijo())).toHaveLength(REGLAS_STOCK.maximoIntentos);
      expect(await orden(k.salida)).toMatchObject({
        estado: 'FALLIDO',
        intentos: REGLAS_STOCK.maximoIntentos,
        error: 'HTTP_503',
      });
      reloj.adelantar(24 * 60);
      await drenar();
      expect(falso.de(prefijo())).toHaveLength(REGLAS_STOCK.maximoIntentos); // ya no insiste

      falso.reiniciar();
      reloj.alPresente();
      const { desde, hasta } = {
        desde: new Date(`${k.fecha}T00:00:00Z`),
        hasta: new Date(`${k.fecha}T00:00:00Z`),
      };
      await c.app.get(StockBookingRepository).registrarVentana(desde, hasta, reloj.ahora(), null);
      cliente.cortacircuito.exito();
      await drenar();
      expect((await orden(k.salida)).estado).toBe('ENVIADO');
    });
  });

  describe('cortacircuitos', () => {
    it('tras 5 fallos seguidos no se llama a Booking mientras esté abierto; las órdenes no gastan intentos y salen al cerrarse', async () => {
      falso.siempre({ status: 503, cuerpo: { success: false } });
      await retener();
      for (let i = 0; i < REGLAS_CORTACIRCUITO.fallosParaAbrir; i++) {
        await drenar();
        if (i < REGLAS_CORTACIRCUITO.fallosParaAbrir - 1) reloj.adelantar(31); // pasa la espera de cada intento
      }
      expect(falso.de(prefijo())).toHaveLength(REGLAS_CORTACIRCUITO.fallosParaAbrir);
      expect(cliente.cortacircuito.abierto).toBe(true);

      // Abierto: un cambio de cupo nuevo (el ajuste del catálogo, sin búsqueda de por medio) deja
      // sus órdenes (la cabina ECONOMY y la BUSINESS), pero el trabajador no las toca ni llama a Booking
      const ahora = reloj.ahora();
      const llamadas = falso.recibidas.length; // las 5 que lo abrieron
      await c
        .admin('patch', `${u.ADMIN}/departures/${k.salida}`, {
          cabins: [{ cabinClass: 'ECONOMY', totalSeats: 6 }],
        })
        .expect(200);
      await drenar();
      expect(falso.recibidas).toHaveLength(llamadas);
      const intacta = await orden(k.salida);
      expect(intacta).toMatchObject({ estado: 'PENDIENTE', intentos: 0, lease: null });
      expect(intacta.proximo.getTime()).toBe(ahora.getTime()); // nadie la tomó ni la soltó

      // Vencida la espera, Booking sigue caído: entra UNA sola prueba, no las dos órdenes
      reloj.adelantar(REGLAS_CORTACIRCUITO.aperturaInicialMs / MINUTO + 0.1);
      await drenar();
      expect(falso.recibidas.length).toBe(llamadas + 1);
      expect(cliente.cortacircuito.abierto).toBe(true);

      // Booking vuelve: la siguiente prueba sale bien, se cierra y se mandan las dos órdenes
      falso.reiniciar();
      reloj.adelantar((2 * REGLAS_CORTACIRCUITO.aperturaInicialMs) / MINUTO + 0.1);
      await drenar();
      expect(cliente.cortacircuito.abierto).toBe(false);
      expect(
        falso
          .de(prefijo())
          .map((r) => r.registro.item_id)
          .sort(),
      ).toEqual([`${k.vuelo}-BUSINESS`, `${k.vuelo}-ECONOMY`].sort());
      expect(unidades().at(-1)).toBe(await disponibles(k.salida));
      expect((await orden(k.salida)).estado).toBe('ENVIADO');
    });

    it('un rechazo de validación no cuenta como caída: Booking está vivo', async () => {
      for (let i = 0; i < REGLAS_CORTACIRCUITO.fallosParaAbrir + 1; i++) {
        falso.responder({ status: 422, cuerpo: { success: false, message: 'no' } });
        await retener();
        await drenar();
      }
      expect(cliente.cortacircuito.abierto).toBe(false);
    });
  });

  describe('lo que no debe pasar', () => {
    it('ni la URL de Booking, ni el cuerpo entero, ni un token llegan al log; las métricas no llevan ids', async () => {
      await retener();
      await drenar(); // un envío bueno
      falso.responder({
        status: 422,
        cuerpo: { success: false, message: 'rechazado', echo: { documento: '1712345678' } },
      });
      await retener();
      await drenar();
      const texto = log.texto();
      expect(texto).not.toContain(falso.url);
      expect(texto).not.toContain(`:${falso.puerto}`);
      expect(texto).not.toContain(RUTA);
      expect(texto).not.toContain('1712345678');
      expect(texto).not.toContain('Bearer');

      const metricas = await c.app.get(Observabilidad).metricas.exponer();
      expect(metricas).toMatch(/core_stock_push_total\{result="ok"\} [1-9]/);
      expect(metricas).toMatch(/core_stock_push_total\{result="rejected"\} [1-9]/);
      expect(metricas).toMatch(/core_stock_pending /);
      expect(metricas).toMatch(/core_stock_oldest_pending_seconds /);
      expect(metricas).toMatch(/job="stock-booking"/);
      expect(metricas).not.toContain(k.vuelo);
      expect(metricas).not.toContain(k.salida);
    });
  });

  describe('sincronización completa', () => {
    const dia = () => new Date(`${k.fecha}T00:00:00.000Z`);

    it('registra una orden por cada (salida, cabina) de la ventana y el trabajador las manda todas', async () => {
      const repo = c.app.get(StockBookingRepository);
      const claves = await repo.registrarVentana(dia(), dia(), reloj.ahora(), 'corr-sync-prueba');
      expect(claves).toBeGreaterThanOrEqual(2);
      expect((await orden(k.salida)).corr).toBe('corr-sync-prueba');
      await drenar();
      const mias = falso
        .de(prefijo())
        .map((r) => r.registro.item_id)
        .sort();
      expect(mias).toEqual([`${k.vuelo}-BUSINESS`, `${k.vuelo}-ECONOMY`].sort());
      // Las órdenes llevaron la correlación que se les dio
      expect(falso.de(prefijo()).every((r) => r.correlacion === 'corr-sync-prueba')).toBe(true);
      expect(falso.recibidas.length).toBe(claves);
    });

    it('SincronizadorStock.simular arma los mismos registros sin escribir nada', async () => {
      const sincronizador = c.app.get(SincronizadorStock);
      const registros = await sincronizador.simular();
      const mio = registros.find((r) => r.item_id === `${k.vuelo}-ECONOMY` && r.date === k.fecha);
      expect(mio).toEqual({
        service_id: SERVICE_ID,
        item_id: `${k.vuelo}-ECONOMY`,
        date: k.fecha,
        time_slot: '10:00',
        available_units: await disponibles(k.salida),
      });
      expect(falso.recibidas).toHaveLength(0);
    });

    it('el comando --dry-run imprime lo que mandaría sin llamar a Booking ni escribir', async () => {
      const antes = await orden(k.salida);
      const env = { ...process.env, ...ENTORNO(falso.url) } as NodeJS.ProcessEnv;
      delete env.BOOKING_STOCK_ENABLED; // --dry-run no lo necesita
      const { stdout, stderr } = await exec('node', [SCRIPT, '--dry-run'], {
        cwd: RAIZ,
        env,
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120_000,
      });
      const lineas = stdout
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(lineas.length).toBeGreaterThan(50);
      expect(
        lineas.find((l) => l.item_id === `${k.vuelo}-ECONOMY` && l.date === k.fecha),
      ).toMatchObject({
        service_id: SERVICE_ID,
        time_slot: '10:00',
      });
      expect(stderr).toMatch(/--dry-run: \d+ registros/);
      // Por un pipe la salida llega completa: el comando espera a vaciar stdout antes de salir
      expect(lineas).toHaveLength(Number(/--dry-run: (\d+) registros/.exec(stderr)![1]));
      expect(falso.recibidas).toHaveLength(0);
      expect(await orden(k.salida)).toEqual(antes);
    }, 130_000);

    it('sin --dry-run el comando exige BOOKING_STOCK_ENABLED=true', async () => {
      const env = { ...process.env, ...ENTORNO(falso.url) } as NodeJS.ProcessEnv;
      delete env.BOOKING_STOCK_ENABLED;
      await expect(exec('node', [SCRIPT], { cwd: RAIZ, env })).rejects.toMatchObject({
        code: 2,
        stderr: expect.stringContaining('BOOKING_STOCK_ENABLED=true'),
      });
      expect(falso.recibidas).toHaveLength(0);
    });

    it('el comando de verdad registra la ventana, la manda con el trabajador y termina en 0', async () => {
      const { stderr } = await exec('node', [SCRIPT], {
        cwd: RAIZ,
        env: {
          ...process.env,
          ...ENTORNO(falso.url),
          BOOKING_STOCK_DIAS: '2',
        } as NodeJS.ProcessEnv,
        maxBuffer: 64 * 1024 * 1024,
        timeout: 170_000,
      });
      expect(stderr).toMatch(/Registradas \d+ claves/);
      expect(stderr).toMatch(
        /Listo: \d+ enviados; 0 FALLIDAS, 0 esperando un reintento, 0 sin mandar/,
      );
      expect(falso.recibidas.length).toBeGreaterThan(50);
      for (const r of falso.recibidas) {
        expect(r.registro).toMatchObject({ service_id: SERVICE_ID });
        expect(r.registro.item_id).toMatch(
          /^[A-Z0-9]{3,6}-(ECONOMY|PREMIUM_ECONOMY|BUSINESS|FIRST)$/,
        );
        expect(r.registro.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(r.registro.time_slot).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
        expect(r.correlacion).toMatch(/^corr-/);
      }
    }, 180_000);
  });
});
