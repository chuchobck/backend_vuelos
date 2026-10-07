import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { desactivarUsuariosDePrueba } from './utils/auth';
import {
  crearCadena,
  CadenaBusqueda,
  darDeBajaCadena,
  fechaEn,
  HUELLA,
  liberarReserva,
  reservarAsiento,
} from './utils/busqueda';
import { ADMIN, AppCatalogo, crearAppCatalogo } from './utils/catalogo';
import { erroresContraContrato } from './utils/contrato';
import { crearApp } from './utils/crear-app';
import { RelojDePrueba } from './utils/reloj';
import { esperarProblemDetails } from './utils/problem-details';

type Cuerpo = Record<string, unknown>;
type Oferta = {
  offerId: string;
  airline: { code: string };
  itineraries: Array<{
    itineraryId: string;
    stopsCount: number;
    segments: Array<{
      segmentId: string;
      flightNumber: string;
      departure: { iataCode: string; at: string };
      arrival: { iataCode: string; at: string };
      layoverMinutes?: number;
    }>;
    pricingOptions: Array<{
      fareBrand: string;
      availableSeats: number;
      pricePerPassengerType: Array<{ passengerType: string; price: { total: string } }>;
    }>;
  }>;
  grandTotal: { currency: string; baseFare: string; taxes: string; total: string };
};

const BUSQUEDA = '/flights/v1/search';
const tramo = (origin: string, destination: string, dias: number | string) => ({
  origin,
  destination,
  departureDate: typeof dias === 'string' ? dias : fechaEn(dias),
});

function buscar(
  app: INestApplication,
  cuerpo: object,
  huella: string | null = HUELLA,
): request.Test {
  const peticion = request(app.getHttpServer()).post(BUSQUEDA);
  return (huella === null ? peticion : peticion.set('X-Device-Fingerprint', huella)).send(cuerpo);
}

function mapa(app: INestApplication, oferta: string, segmento?: string): request.Test {
  return request(app.getHttpServer())
    .get(`/flights/v1/offers/${oferta}/seatmap`)
    .query(segmento ? { segmentId: segmento } : {});
}

/** Suma de dinero en centavos, para comparar sin pasar por un float. */
const centavos = (texto: string) => {
  const [enteros, decimales = ''] = texto.split('.');
  return BigInt(enteros) * 100n + BigInt(decimales.padEnd(2, '0'));
};

describe('POST /search con la semilla', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await crearApp();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    await app.close();
  });

  it('solo ida UIO-GYE: ofertas directas válidas contra SearchResponse del contrato', async () => {
    const respuesta = await buscar(app, {
      itineraries: [tramo('UIO', 'GYE', 10)],
      passengers: { adults: 1 },
    }).expect(200);

    expect(erroresContraContrato('SearchResponse', respuesta.body)).toEqual([]);
    const ofertas = respuesta.body.offers as Oferta[];
    expect(respuesta.body.totalOffers).toBe(ofertas.length);
    expect(ofertas.length).toBeGreaterThan(0);
    for (const oferta of ofertas) {
      expect(oferta.itineraries).toHaveLength(1);
      const [itinerario] = oferta.itineraries;
      // Directos y, más caros, con escala (UIO-CUE-GYE, por ejemplo)
      expect(itinerario.segments[0].departure.iataCode).toBe('UIO');
      expect(itinerario.segments[itinerario.segments.length - 1].arrival.iataCode).toBe('GYE');
      expect(new Date(itinerario.segments[0].departure.at).getTime()).toBeGreaterThan(Date.now());
      expect(
        itinerario.pricingOptions[0].pricePerPassengerType.map((p) => p.passengerType),
      ).toEqual(['ADULT']);
    }
    expect(ofertas.some((o) => o.itineraries[0].stopsCount === 0)).toBe(true);
    // Orden determinista: precio total y luego hora de salida
    for (let i = 1; i < ofertas.length; i++) {
      const [a, b] = [ofertas[i - 1], ofertas[i]];
      const comparacion = Number(centavos(a.grandTotal.total) - centavos(b.grandTotal.total));
      expect(comparacion).toBeLessThanOrEqual(0);
      if (comparacion === 0) {
        expect(
          a.itineraries[0].segments[0].departure.at <= b.itineraries[0].segments[0].departure.at,
        ).toBe(true);
      }
    }
  });

  it('el precio es el de la base: la familia más barata del segmento, en texto', async () => {
    const [oferta] = (
      await buscar(app, {
        itineraries: [tramo('UIO', 'GYE', 11)],
        passengers: { adults: 1 },
      }).expect(200)
    ).body.offers as Oferta[];
    const segmento = oferta.itineraries[0].segments[0].segmentId;
    const marca = oferta.itineraries[0].pricingOptions[0].fareBrand;
    const [precio] = await prisma.db.$queryRaw<Array<{ base: string; impuestos: string }>>`
      SELECT td.tarifa_base::text AS base, td.impuestos::text AS impuestos
        FROM vuelos.tarifa_detalle td
        JOIN vuelos.tarifa_cabecera t ON t.id = td.tarifa_id
        JOIN vuelos.familia_tarifa f ON f.id = t.familia_tarifa_id
       WHERE t.vuelo_programado_id = ${segmento}::uuid AND f.codigo = ${marca} AND td.tipo_pasajero = 'ADULTO'`;
    expect(oferta.grandTotal).toEqual({
      currency: 'USD',
      baseFare: precio.base,
      taxes: precio.impuestos,
      total: (Number(centavos(precio.base) + centavos(precio.impuestos)) / 100).toFixed(2),
    });
  });

  it('UIO-GPS con varios pasajeros: escalas por GYE y el total por tipo de pasajero', async () => {
    const respuesta = await buscar(app, {
      itineraries: [tramo('UIO', 'GPS', 10)],
      passengers: { adults: 2, children: 1, infants: 1 },
    }).expect(200);
    expect(erroresContraContrato('SearchResponse', respuesta.body)).toEqual([]);

    const ofertas = respuesta.body.offers as Oferta[];
    expect(ofertas.length).toBeGreaterThan(0);
    for (const oferta of ofertas) {
      const [itinerario] = oferta.itineraries;
      expect(itinerario.stopsCount).toBe(1);
      expect(itinerario.segments.map((s) => s.departure.iataCode)).toEqual(['UIO', 'GYE']);
      expect(itinerario.segments[1].layoverMinutes).toBeGreaterThanOrEqual(45);
      expect(itinerario.segments[1].layoverMinutes).toBeLessThanOrEqual(360);
      // Mismo vuelo comercial en las dos piernas: la oferta es de una sola aerolínea
      expect(itinerario.segments.every((s) => s.flightNumber.startsWith(oferta.airline.code))).toBe(
        true,
      );

      const opcion = itinerario.pricingOptions[0];
      expect(opcion.pricePerPassengerType.map((p) => p.passengerType)).toEqual([
        'ADULT',
        'CHILD',
        'INFANT',
      ]);
      const [adulto, nino, infante] = opcion.pricePerPassengerType.map((p) =>
        centavos(p.price.total),
      );
      expect(centavos(oferta.grandTotal.total)).toBe(2n * adulto + nino + infante);
    }
  });

  it('ida y vuelta: dos itinerarios por oferta, la vuelta sale después de llegar la ida', async () => {
    const respuesta = await buscar(app, {
      itineraries: [tramo('UIO', 'GYE', 12), tramo('GYE', 'UIO', 14)],
      passengers: { adults: 1 },
    }).expect(200);
    expect(erroresContraContrato('SearchResponse', respuesta.body)).toEqual([]);
    for (const oferta of respuesta.body.offers as Oferta[]) {
      const [ida, vuelta] = oferta.itineraries;
      expect(ida.segments[0].departure.iataCode).toBe('UIO');
      expect(vuelta.segments[0].departure.iataCode).toBe('GYE');
      expect(
        vuelta.segments[0].departure.at > ida.segments[ida.segments.length - 1].arrival.at,
      ).toBe(true);
    }
    expect(respuesta.body.offers.length).toBeLessThanOrEqual(20);
  });

  it('multidestino de tres tramos: un itinerario por tramo, en orden', async () => {
    const respuesta = await buscar(app, {
      itineraries: [tramo('UIO', 'GYE', 10), tramo('GYE', 'GPS', 12), tramo('GPS', 'GYE', 15)],
      passengers: { adults: 1, youths: 1 },
    }).expect(200);
    expect(erroresContraContrato('SearchResponse', respuesta.body)).toEqual([]);
    const ofertas = respuesta.body.offers as Oferta[];
    expect(ofertas.length).toBeGreaterThan(0);
    for (const oferta of ofertas) {
      expect(
        oferta.itineraries.map((i) => [
          i.segments[0].departure.iataCode,
          i.segments[i.segments.length - 1].arrival.iataCode,
        ]),
      ).toEqual([
        ['UIO', 'GYE'],
        ['GYE', 'GPS'],
        ['GPS', 'GYE'],
      ]);
    }
  });

  it('sin resultados: 200 con la lista vacía (aeropuerto sin vuelos)', async () => {
    const respuesta = await buscar(app, {
      itineraries: [tramo('UIO', 'XYZ', 10)],
      passengers: {},
    }).expect(200);
    expect(respuesta.body).toEqual({ totalOffers: 0, offers: [] });
  });

  it('funciona sin token y no devuelve datos internos', async () => {
    const respuesta = await buscar(app, {
      itineraries: [tramo('GYE', 'UIO', 13)],
      passengers: { adults: 1 },
    }).expect(200);
    const texto = JSON.stringify(respuesta.body);
    // Ni la huella, ni ENUM en español, ni ids internos
    expect(texto).not.toContain(HUELLA);
    for (const interno of [
      'ECONOMICA',
      'EJECUTIVA',
      'PROGRAMADO',
      'ADULTO',
      'aerolinea',
      'familia',
      'id_publico',
    ]) {
      expect(texto).not.toContain(interno);
    }
    for (const oferta of respuesta.body.offers as Oferta[]) {
      expect(oferta.offerId).toMatch(/^[0-9a-f-]{36}$/);
      for (const it of oferta.itineraries) {
        expect(it.itineraryId).toMatch(/^[0-9a-f-]{36}$/);
        for (const s of it.segments) expect(s.segmentId).toMatch(/^[0-9a-f-]{36}$/);
      }
    }
    expect(respuesta.headers['cache-control']).toBe('no-store');
  });

  it('guarda las ofertas con la huella y su vigencia, sin tocar cupos ni auditoría', async () => {
    const cupos = () =>
      prisma.db.inventario_cabina.aggregate({ _sum: { cupos_disponibles: true } });
    const antes = { cupos: await cupos(), auditoria: await prisma.db.auditoria.count() };

    const respuesta = await buscar(app, {
      itineraries: [tramo('UIO', 'CUE', 10)],
      passengers: { adults: 3 },
    }).expect(200);
    const ofertas = respuesta.body.offers as Oferta[];
    expect(ofertas.length).toBeGreaterThan(0);

    const guardadas = await prisma.db.oferta_cabecera.findMany({
      where: { id: { in: ofertas.map((o) => o.offerId) } },
      include: {
        oferta_detalle: {
          include: { itinerario_cabecera: { include: { itinerario_detalle: true } } },
        },
      },
    });
    expect(guardadas).toHaveLength(ofertas.length);
    for (const guardada of guardadas) {
      expect(guardada.huella_dispositivo).toBe(HUELLA);
      const minutos =
        (guardada.fecha_expiracion.getTime() - guardada.fecha_creacion.getTime()) / 60_000;
      expect(Math.round(minutos)).toBe(30);
      const oferta = ofertas.find((o) => o.offerId === guardada.id)!;
      expect(guardada.oferta_detalle[0].itinerario_id).toBe(oferta.itineraries[0].itineraryId);
      expect(
        guardada.oferta_detalle[0].itinerario_cabecera.itinerario_detalle.map(
          (d) => d.vuelo_programado_id,
        ),
      ).toEqual(oferta.itineraries[0].segments.map((s) => s.segmentId));
    }

    expect(await cupos()).toEqual(antes.cupos);
    expect(await prisma.db.auditoria.count()).toBe(antes.auditoria);
  });

  it('repetir búsquedas no acumula basura: las ofertas vencidas sin retención se purgan', async () => {
    const vencida = (
      await buscar(app, { itineraries: [tramo('UIO', 'GYE', 10)], passengers: {} }).expect(200)
    ).body.offers[0] as Oferta;
    await prisma.db.$executeRaw`
      UPDATE vuelos.oferta_cabecera
         SET fecha_creacion = now() - interval '2 hours', fecha_expiracion = now() - interval '1 hour'
       WHERE id = ${vencida.offerId}::uuid`;
    await prisma.db.$executeRaw`
      UPDATE vuelos.itinerario_cabecera SET fecha_creacion = now() - interval '2 hours'
       WHERE id = ${vencida.itineraries[0].itineraryId}::uuid`;

    await buscar(app, { itineraries: [tramo('UIO', 'LOH', 11)], passengers: {} }).expect(200);

    expect(await prisma.db.oferta_cabecera.count({ where: { id: vencida.offerId } })).toBe(0);
    expect(
      await prisma.db.itinerario_cabecera.count({
        where: { id: vencida.itineraries[0].itineraryId },
      }),
    ).toBe(0);
    await mapa(app, vencida.offerId, vencida.itineraries[0].segments[0].segmentId).expect(404);
  });

  it('el mapa de asientos de una oferta cumple SeatMapResponse del contrato', async () => {
    const [oferta] = (
      await buscar(app, { itineraries: [tramo('UIO', 'GYE', 10)], passengers: {} }).expect(200)
    ).body.offers as Oferta[];
    const segmento = oferta.itineraries[0].segments[0].segmentId;
    const respuesta = await mapa(app, oferta.offerId, segmento).expect(200);

    expect(erroresContraContrato('SeatMapResponse', respuesta.body)).toEqual([]);
    expect(respuesta.body.segmentId).toBe(segmento);
    const asientos = (respuesta.body.cabins as Array<{ rows: Array<{ seats: Cuerpo[] }> }>).flatMap(
      (c) => c.rows.flatMap((f) => f.seats),
    );
    expect(asientos.length).toBeGreaterThan(0);
    expect(asientos.every((a) => /^\d{1,2}[A-HJK]$/.test(a.seatNumber as string))).toBe(true);
    expect(JSON.stringify(respuesta.body)).not.toMatch(/price|total|"id"/);
  });
});

describe('POST /search: validación', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await crearApp();
  });
  afterAll(async () => {
    await app.close();
  });

  const valido = { itineraries: [tramo('UIO', 'GYE', 10)], passengers: { adults: 1 } };

  it.each([
    ['sin cabecera X-Device-Fingerprint', valido, null, 'X-Device-Fingerprint'],
    ['cabecera demasiado corta', valido, 'abc', 'X-Device-Fingerprint'],
    ['cabecera con espacios', valido, 'abcd efgh ij', 'X-Device-Fingerprint'],
    ['sin tramos', { itineraries: [], passengers: {} }, HUELLA, 'itineraries'],
    [
      'siete tramos',
      { itineraries: Array(7).fill(tramo('UIO', 'GYE', 10)), passengers: {} },
      HUELLA,
      'itineraries',
    ],
    [
      'IATA en minúsculas',
      { itineraries: [tramo('uio', 'GYE', 10)], passengers: {} },
      HUELLA,
      'itineraries[0].origin',
    ],
    [
      'fecha que no existe',
      { itineraries: [tramo('UIO', 'GYE', '2026-02-30')], passengers: {} },
      HUELLA,
      'itineraries[0].departureDate',
    ],
    [
      'fecha pasada',
      { itineraries: [tramo('UIO', 'GYE', -2)], passengers: {} },
      HUELLA,
      'itineraries[0].departureDate',
    ],
    [
      'más de un año adelante',
      { itineraries: [tramo('UIO', 'GYE', 400)], passengers: {} },
      HUELLA,
      'itineraries[0].departureDate',
    ],
    [
      'vuelta antes que la ida',
      { itineraries: [tramo('UIO', 'GYE', 12), tramo('GYE', 'UIO', 10)], passengers: {} },
      HUELLA,
      'itineraries[1].departureDate',
    ],
    [
      'origen igual al destino',
      { itineraries: [tramo('UIO', 'UIO', 10)], passengers: {} },
      HUELLA,
      'itineraries[0].destination',
    ],
    ['sin pasajeros', { itineraries: [tramo('UIO', 'GYE', 10)] }, HUELLA, 'passengers'],
    [
      'cero adultos',
      { itineraries: [tramo('UIO', 'GYE', 10)], passengers: { adults: 0 } },
      HUELLA,
      'passengers.adults',
    ],
    [
      'más infantes que adultos',
      { itineraries: [tramo('UIO', 'GYE', 10)], passengers: { adults: 1, infants: 2 } },
      HUELLA,
      'passengers.infants',
    ],
    [
      'diez pasajeros con asiento',
      { itineraries: [tramo('UIO', 'GYE', 10)], passengers: { adults: 5, children: 5 } },
      HUELLA,
      'passengers',
    ],
    ['un campo que el contrato no tiene', { ...valido, currency: 'USD' }, HUELLA, 'currency'],
  ])('%s: 400', async (_caso, cuerpo, huella, campo) => {
    const respuesta = await buscar(app, cuerpo, huella);
    expect(respuesta.status).toBe(400);
    esperarProblemDetails(respuesta);
    expect(respuesta.body.code).toBe('VALIDATION_FAILED');
    expect((respuesta.body.invalidParams as Array<{ name: string }>).map((p) => p.name)).toContain(
      campo,
    );
    if (huella)
      expect(JSON.stringify(respuesta.body)).not.toContain(huella === HUELLA ? HUELLA : huella);
  });
});

describe('Búsqueda y mapa de asientos sobre un catálogo propio', () => {
  let c: AppCatalogo;
  let k: CadenaBusqueda;
  let oferta: Oferta;
  let reserva: string;

  const buscarCadena = (passengers: object) =>
    buscar(c.app, { itineraries: [tramo(k.origen, k.destino, k.fecha)], passengers });

  beforeAll(async () => {
    c = await crearAppCatalogo();
    k = await crearCadena(c);
  });
  afterAll(async () => {
    if (reserva) await liberarReserva(c.prisma, reserva);
    await darDeBajaCadena(c, k);
    await desactivarUsuariosDePrueba(c.app);
    await c.cerrar();
  });

  it('encuentra la única salida con su cupo y su precio', async () => {
    const respuesta = await buscarCadena({ adults: 1, children: 1 }).expect(200);
    expect(respuesta.body.totalOffers).toBe(1);
    oferta = respuesta.body.offers[0];
    const [opcion] = oferta.itineraries[0].pricingOptions;
    expect(opcion).toMatchObject({ fareBrand: 'BUSCA', availableSeats: 2 });
    expect(oferta.grandTotal).toEqual({
      currency: 'USD',
      baseFare: '90.10',
      taxes: '18.20',
      total: '108.30',
    });
  });

  it('con más pasajeros que cupos no aparece; los infantes no ocupan cupo', async () => {
    expect((await buscarCadena({ adults: 3 }).expect(200)).body.totalOffers).toBe(0);
    expect((await buscarCadena({ adults: 2, infants: 2 }).expect(200)).body.totalOffers).toBe(1);
  });

  it('el mapa: ejecutiva sin cupo no disponible, económica disponible, con sus características', async () => {
    const respuesta = await mapa(c.app, oferta.offerId, k.salida).expect(200);
    expect(erroresContraContrato('SeatMapResponse', respuesta.body)).toEqual([]);
    expect(respuesta.body.cabins).toEqual([
      {
        cabinClass: 'BUSINESS',
        rows: [
          {
            rowNumber: 1,
            seats: [
              { seatNumber: '1A', isAvailable: false, characteristics: ['WINDOW'] },
              { seatNumber: '1C', isAvailable: false, characteristics: ['WINDOW'] },
            ],
          },
        ],
      },
      {
        cabinClass: 'ECONOMY',
        rows: [
          {
            rowNumber: 2,
            seats: [
              { seatNumber: '2A', isAvailable: true, characteristics: ['WINDOW', 'EXTRA_LEGROOM'] },
              { seatNumber: '2B', isAvailable: true, characteristics: ['AISLE', 'EXTRA_LEGROOM'] },
              { seatNumber: '2C', isAvailable: true, characteristics: ['WINDOW', 'EXTRA_LEGROOM'] },
            ],
          },
          {
            rowNumber: 3,
            seats: [
              {
                seatNumber: '3A',
                isAvailable: true,
                characteristics: ['WINDOW', 'EMERGENCY_EXIT'],
              },
              { seatNumber: '3B', isAvailable: true, characteristics: ['AISLE', 'EMERGENCY_EXIT'] },
              {
                seatNumber: '3C',
                isAvailable: true,
                characteristics: ['WINDOW', 'EMERGENCY_EXIT'],
              },
            ],
          },
        ],
      },
    ]);
  });

  it('un asiento asignado en una reserva sale como no disponible', async () => {
    reserva = await reservarAsiento(c.prisma, k.salida, '2B');
    const respuesta = await mapa(c.app, oferta.offerId, k.salida).expect(200);
    const fila2 = respuesta.body.cabins[1].rows[0].seats as Array<{
      seatNumber: string;
      isAvailable: boolean;
    }>;
    expect(fila2.map((s) => `${s.seatNumber}=${s.isAvailable}`)).toEqual([
      '2A=true',
      '2B=false',
      '2C=true',
    ]);
  });

  it('un segmento que no es de la oferta, o una oferta inexistente: 404', async () => {
    const otraSalida = (
      await c.prisma.db.vuelo_programado.findFirstOrThrow({ where: { NOT: { id: k.salida } } })
    ).id;
    const ajeno = await mapa(c.app, oferta.offerId, otraSalida);
    expect(ajeno.status).toBe(404);
    esperarProblemDetails(ajeno);
    expect(ajeno.body.detail).toMatch(/is not part of offer/);
    await mapa(c.app, '00000000-0000-4000-8000-000000000000', k.salida).expect(404);
    await mapa(c.app, 'no-es-uuid', k.salida).expect(400);
    await mapa(c.app, oferta.offerId).expect(400);
  });

  it('una oferta vencida: 404', async () => {
    const vigente = (await buscarCadena({ adults: 1 }).expect(200)).body.offers[0] as Oferta;
    await c.prisma.db.$executeRaw`
      UPDATE vuelos.oferta_cabecera
         SET fecha_creacion = now() - interval '1 hour', fecha_expiracion = now() - interval '1 minute'
       WHERE id = ${vigente.offerId}::uuid`;
    const respuesta = await mapa(c.app, vigente.offerId, k.salida);
    expect(respuesta.status).toBe(404);
    expect(respuesta.body.detail).toMatch(/was not found or has expired/);
  });

  it('una tarifa dada de baja no se vende; reactivada, vuelve', async () => {
    await c.admin('delete', `${ADMIN}/fares/${k.tarifa}`).expect(204);
    expect((await buscarCadena({ adults: 1 }).expect(200)).body.totalOffers).toBe(0);
    await c.admin('post', `${ADMIN}/fares/${k.tarifa}/reactivate`).expect(200);
    expect((await buscarCadena({ adults: 1 }).expect(200)).body.totalOffers).toBe(1);
  });

  it('una salida cancelada no aparece ni se puede ver su mapa', async () => {
    await liberarReserva(c.prisma, reserva);
    reserva = '';
    await c.admin('delete', `${ADMIN}/departures/${k.salida}`).expect(204);
    expect((await buscarCadena({ adults: 1 }).expect(200)).body.totalOffers).toBe(0);
    const respuesta = await mapa(c.app, oferta.offerId, k.salida);
    expect(respuesta.status).toBe(404);
    expect(respuesta.body.detail).toMatch(/is no longer available/);
    await c.admin('post', `${ADMIN}/departures/${k.salida}/reactivate`).expect(200);
  });
});

describe('Límite de peticiones de la búsqueda y del mapa', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await crearApp([], { reloj: new RelojDePrueba() });
  });
  afterAll(async () => {
    await app.close();
  });

  it('20 búsquedas por minuto e IP; la siguiente es 429 con Retry-After', async () => {
    const sinResultados = { itineraries: [tramo('UIO', 'XYZ', 10)], passengers: {} };
    for (let i = 0; i < 20; i++) await buscar(app, sinResultados).expect(200);
    const excedida = await buscar(app, sinResultados);
    expect(excedida.status).toBe(429);
    esperarProblemDetails(excedida);
    expect(excedida.body.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(Number(excedida.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('el mapa tiene su propio contador de 60 por minuto', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    for (let i = 0; i < 60; i++) await mapa(app, id, id).expect(404);
    const excedida = await mapa(app, id, id);
    expect(excedida.status).toBe(429);
    expect(excedida.body.code).toBe('RATE_LIMIT_EXCEEDED');
  });
});
