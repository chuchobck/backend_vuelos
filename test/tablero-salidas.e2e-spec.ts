import * as request from 'supertest';
import { ES_LIMITE_ESTRICTO } from '../src/common/decorators/limite-peticiones.decorator';
import { aHoraLocal } from '../src/modules/vuelos/compartido/fechas';
import {
  LIMITE_SALIDAS_PUBLICAS,
  TableroSalidasController,
} from '../src/modules/vuelos/operaciones/tablero-salidas/tablero-salidas.controller';
import { desactivarUsuariosDePrueba } from './utils/auth';
import { CadenaBusqueda, crearCadena, darDeBajaCadena, fechaEn } from './utils/busqueda';
import { ADMIN, AppCatalogo, codigos, crearAppCatalogo, enDias } from './utils/catalogo';
import { LimitesReiniciables } from './utils/limites';
import { esperarProblemDetails } from './utils/problem-details';
import { RelojDePrueba } from './utils/reloj';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- cuerpos JSON de la API
type Cuerpo = Record<string, any>;

const SALIDAS = (iata: string, query = '') =>
  `/flights/v1/airports/${iata}/departures${query ? `?${query}` : ''}`;

describe('Salidas públicas de un aeropuerto (/airports/{iataCode}/departures)', () => {
  const reloj = new RelojDePrueba();
  const limites = new LimitesReiniciables();
  let c: AppCatalogo;
  let k: CadenaBusqueda;
  /** Una segunda salida del vuelo de la cadena: 22:00 locales del mismo día (03:00 UTC del siguiente). */
  let nocturna: string;

  const http = () => request(c.app.getHttpServer());
  const salidas = (iata: string, query = '') => http().get(SALIDAS(iata, query));

  /** Las salidas de un aeropuerto en una fecha local, como están en la base. */
  const deLaBase = (iata: string, fecha: string) =>
    c.prisma.db.$queryRaw<
      Array<{ numero: string; programada: Date; destino: string; estado: string }>
    >`
      SELECT ac.codigo_iata || v.numero AS numero, vp.salida_programada AS programada,
             pd.codigo_iata AS destino, vp.estado::text AS estado
        FROM vuelos.vuelo_programado vp
        JOIN vuelos.vuelo v       ON v.id = vp.vuelo_id
        JOIN vuelos.aerolinea ac  ON ac.id = v.aerolinea_id
        JOIN vuelos.aeropuerto po ON po.id = v.aeropuerto_origen_id
        JOIN vuelos.aeropuerto pd ON pd.id = v.aeropuerto_destino_id
       WHERE po.codigo_iata = ${iata} AND vp.fecha_salida = ${fecha}::date
       ORDER BY vp.salida_programada, vp.id`;

  beforeAll(async () => {
    c = await crearAppCatalogo({ reloj, limites });
    k = await crearCadena(c);
    nocturna = (
      await c
        .admin('post', `${ADMIN}/departures`, {
          flightNumber: k.vuelo,
          seatMapId: k.mapa,
          // El vuelo solo admite una salida por fecha local: esta es del día siguiente, 22:00 locales
          scheduledDeparture: enDias(22, 3),
          scheduledArrival: enDias(22, 4),
          cabins: [{ cabinClass: 'ECONOMY', totalSeats: 2 }],
        })
        .expect(201)
    ).body.id;
  });
  beforeEach(() => {
    reloj.alPresente();
    limites.reiniciar();
  });
  afterAll(async () => {
    await c.admin('delete', `${ADMIN}/departures/${nocturna}`);
    await darDeBajaCadena(c, k);
    await desactivarUsuariosDePrueba(c.app);
    await c.cerrar();
  });

  describe('una salida propia, sin token', () => {
    it('200 con el aeropuerto, la fecha y la salida en hora local con su desplazamiento', async () => {
      const r = await salidas(k.origen, `date=${k.fecha}`);
      expect(r.status).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
      const ciudad = (await c.admin('get', `${ADMIN}/airports/${k.destino}`).expect(200)).body;
      expect(r.body).toEqual({
        airport: {
          iataCode: k.origen,
          name: `Aeropuerto ${k.origen}`,
          city: expect.stringMatching(/^Ciudad /),
          timeZone: 'America/Guayaquil',
        },
        date: k.fecha,
        departures: [
          {
            flightNumber: k.vuelo,
            airline: 'Aerolínea de búsqueda',
            destination: { iataCode: k.destino, city: expect.stringMatching(/^Ciudad /) },
            // 15:00 UTC son las 10:00 de Ecuador continental
            scheduledTime: `${k.fecha}T10:00:00-05:00`,
            estimatedTime: null,
            status: 'SCHEDULED',
            terminal: null,
            gate: null,
          },
        ],
      });
      expect(ciudad.code).toBe(k.destino);
      expect(new Date(r.body.departures[0].scheduledTime).toISOString()).toBe(enDias(20, 15));
    });

    it('la fecha es la LOCAL del aeropuerto: una salida a las 22:00 locales sale en su día local, no en el UTC', async () => {
      const diaLocal = fechaEn(21);
      const diaUtc = fechaEn(22);
      const local = await salidas(k.origen, `date=${diaLocal}`).expect(200);
      expect(local.body.departures).toHaveLength(1);
      expect(local.body.departures[0].scheduledTime).toBe(`${diaLocal}T22:00:00-05:00`);
      expect(new Date(local.body.departures[0].scheduledTime).toISOString()).toBe(enDias(22, 3));
      const utc = await salidas(k.origen, `date=${diaUtc}`).expect(200);
      expect(utc.body.departures).toEqual([]);
    });

    it('sin date responde el día de hoy en la zona del aeropuerto, según el Reloj', async () => {
      // 02:00 UTC del día 22 son las 21:00 del día 21 en Ecuador: "hoy" es el día 21
      reloj.fijar(new Date(enDias(22, 2)));
      const r = await salidas(k.origen).expect(200);
      expect(r.body.date).toBe(fechaEn(21));
      expect(r.body.departures).toHaveLength(1);
    });

    it('muestra la demora, la hora estimada local, el terminal y la puerta que pone el administrador', async () => {
      await c
        .admin('patch', `${ADMIN}/departures/${k.salida}`, {
          status: 'DELAYED',
          estimatedDeparture: enDias(20, 15, 45),
          departureTerminal: 'T1',
          departureGate: 'B-07',
        })
        .expect(200);
      try {
        const r = await salidas(k.origen, `date=${k.fecha}`).expect(200);
        expect(r.body.departures[0]).toMatchObject({
          scheduledTime: `${k.fecha}T10:00:00-05:00`,
          estimatedTime: `${k.fecha}T10:45:00-05:00`,
          status: 'DELAYED',
          terminal: 'T1',
          gate: 'B-07',
        });
      } finally {
        await c
          .admin('patch', `${ADMIN}/departures/${k.salida}`, {
            status: 'SCHEDULED',
            estimatedDeparture: null,
            departureTerminal: null,
            departureGate: null,
          })
          .expect(200);
      }
    });

    it('una salida cancelada sigue en la pantalla, como CANCELLED', async () => {
      await c.admin('delete', `${ADMIN}/departures/${nocturna}`).expect(204);
      const r = await salidas(k.origen, `date=${fechaEn(21)}`).expect(200);
      expect(r.body.departures.map((s: Cuerpo) => s.status)).toEqual(['CANCELLED']);
    });

    it('no trae datos de reservas, cupos ni pasajeros: solo los campos de la pantalla', async () => {
      const r = await salidas(k.origen, `date=${k.fecha}`).expect(200);
      expect(Object.keys(r.body).sort()).toEqual(['airport', 'date', 'departures']);
      expect(Object.keys(r.body.departures[0]).sort()).toEqual([
        'airline',
        'destination',
        'estimatedTime',
        'flightNumber',
        'gate',
        'scheduledTime',
        'status',
        'terminal',
      ]);
      expect(JSON.stringify(r.body)).not.toMatch(
        /passenger|booking|pnr|ticket|seat|price|fare|segmentId|"id"/i,
      );
    });

    it('es pública: responde igual sin token, con un token inválido y con el de un cliente', async () => {
      const sinToken = await salidas(k.origen, `date=${k.fecha}`).expect(200);
      const invalido = await salidas(k.origen, `date=${k.fecha}`)
        .set('Authorization', 'Bearer no-es-un-token')
        .expect(200);
      const cliente = await c.cliente('get', SALIDAS(k.origen, `date=${k.fecha}`)).expect(200);
      expect(invalido.body).toEqual(sinToken.body);
      expect(cliente.body).toEqual(sinToken.body);
    });
  });

  describe('sobre la semilla', () => {
    const dia = fechaEn(40);

    it('Quito: todas las salidas del día, por hora programada, iguales a las de la base', async () => {
      const base = await deLaBase('UIO', dia);
      expect(base.length).toBeGreaterThan(5);
      const r = await salidas('UIO', `date=${dia}&limit=100`).expect(200);
      expect(r.body.nextCursor).toBeUndefined();
      expect(
        r.body.departures.map((s: Cuerpo) => [
          s.flightNumber,
          s.destination.iataCode,
          new Date(s.scheduledTime).toISOString(),
        ]),
      ).toEqual(base.map((f) => [f.numero, f.destino, f.programada.toISOString()]));
      for (const s of r.body.departures) {
        expect(s.scheduledTime).toMatch(new RegExp(`^${dia}T\\d{2}:\\d{2}:\\d{2}-05:00$`));
      }
    });

    it('Galápagos: las horas van con el desplazamiento de su zona (-06:00)', async () => {
      const base = await deLaBase('GPS', dia);
      expect(base.length).toBeGreaterThan(0);
      const r = await salidas('GPS', `date=${dia}`).expect(200);
      expect(r.body.airport.timeZone).toBe('Pacific/Galapagos');
      expect(r.body.departures).toHaveLength(base.length);
      r.body.departures.forEach((s: Cuerpo, i: number) => {
        expect(s.scheduledTime).toMatch(new RegExp(`^${dia}T\\d{2}:\\d{2}:\\d{2}-06:00$`));
        expect(new Date(s.scheduledTime).toISOString()).toBe(base[i].programada.toISOString());
        expect(s.scheduledTime).toBe(aHoraLocal(base[i].programada, 'Pacific/Galapagos'));
      });
    });

    it('paginada: de 7 en 7 con nextCursor, sin repetir ni saltar, y la última sin cursor', async () => {
      const todas = (await salidas('UIO', `date=${dia}&limit=100`).expect(200)).body.departures;
      const juntas: Cuerpo[] = [];
      let cursor: string | undefined;
      let paginas = 0;
      do {
        const r = await salidas(
          'UIO',
          `date=${dia}&limit=7${cursor ? `&cursor=${cursor}` : ''}`,
        ).expect(200);
        expect(r.body.departures.length).toBeLessThanOrEqual(7);
        juntas.push(...r.body.departures);
        cursor = r.body.nextCursor;
        paginas++;
      } while (cursor && paginas < 20);
      expect(juntas).toEqual(todas);
      expect(paginas).toBe(Math.ceil(todas.length / 7));
    });

    it('por defecto da a lo más 50 salidas', async () => {
      const r = await salidas('UIO', `date=${dia}`).expect(200);
      expect(r.body.departures.length).toBeLessThanOrEqual(50);
    });

    it('un día sin salidas: 200 con la lista vacía', async () => {
      const r = await salidas('UIO', 'date=2020-01-01').expect(200);
      expect(r.body).toMatchObject({ date: '2020-01-01', departures: [] });
    });
  });

  describe('errores y límite', () => {
    it.each([
      ['el código en minúsculas', SALIDAS('uio'), 'iataCode'],
      ['un código de 4 letras', SALIDAS('UIOX'), 'iataCode'],
      ['una fecha que no existe', SALIDAS('UIO', 'date=2026-02-30'), 'date'],
      ['una fecha con otro formato', SALIDAS('UIO', 'date=20-10-2026'), 'date'],
      ['limit 0', SALIDAS('UIO', 'limit=0'), 'limit'],
      ['limit 101', SALIDAS('UIO', 'limit=101'), 'limit'],
      ['limit que no es número', SALIDAS('UIO', 'limit=muchas'), 'limit'],
      ['un cursor que no es de esta lista', SALIDAS('UIO', 'cursor=bm8tZXM'), 'cursor'],
      ['un cursor con signos', SALIDAS('UIO', 'cursor=a.b'), 'cursor'],
      ['un parámetro que no existe', SALIDAS('UIO', 'airline=LA'), 'airline'],
    ])('400 con %s', async (_caso, ruta, campo) => {
      const r = await http().get(ruta);
      expect(r.status).toBe(400);
      esperarProblemDetails(r);
      expect(r.body.invalidParams.map((p: Cuerpo) => p.name)).toContain(campo);
    });

    it('un aeropuerto que no existe: 404 ProblemDetails', async () => {
      const libre = await codigos.aeropuerto(c.prisma);
      const r = await salidas(libre);
      expect(r.status).toBe(404);
      esperarProblemDetails(r);
    });

    it('tiene su propio límite: la consulta 61 en un minuto es 429 con Retry-After', async () => {
      expect(LIMITE_SALIDAS_PUBLICAS).toEqual({ limite: 60, ventanaSegundos: 60 });
      expect(
        Reflect.getMetadata(ES_LIMITE_ESTRICTO, TableroSalidasController.prototype.salidas),
      ).toBe(true);
      for (let i = 0; i < LIMITE_SALIDAS_PUBLICAS.limite; i++) {
        expect((await salidas(k.origen, `date=${k.fecha}`)).status).toBe(200);
      }
      const bloqueada = await salidas(k.origen, `date=${k.fecha}`);
      expect([bloqueada.status, bloqueada.body.code]).toEqual([429, 'RATE_LIMIT_EXCEEDED']);
      expect(Number(bloqueada.headers['retry-after'])).toBeGreaterThan(0);
      reloj.adelantar(1);
      expect((await salidas(k.origen, `date=${k.fecha}`)).status).toBe(200);
    });
  });

  describe('un aeropuerto dado de baja', () => {
    it('404: la pantalla solo sirve aeropuertos activos', async () => {
      const libre = await codigos.aeropuerto(c.prisma);
      const ciudad = (await c.admin('get', `${ADMIN}/airports/${k.origen}`).expect(200)).body
        .cityId;
      await c
        .admin('post', `${ADMIN}/airports`, { code: libre, name: 'Temporal', cityId: ciudad })
        .expect(201);
      expect((await salidas(libre)).status).toBe(200);
      await c.admin('delete', `${ADMIN}/airports/${libre}`).expect(204);
      expect((await salidas(libre)).status).toBe(404);
    });
  });
});
