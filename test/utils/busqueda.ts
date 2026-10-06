import { PrismaService } from '../../src/prisma/prisma.service';
import { ADMIN, AppCatalogo, codigos, enDias, sufijo } from './catalogo';

export const HUELLA = 'e2e-busqueda-1b2c3d4e';

/** Una fecha `YYYY-MM-DD` dentro de `dias` días (en UTC, como las fechas de la semilla). */
export function fechaEn(dias: number): string {
  return enDias(dias, 12).slice(0, 10);
}

export interface CadenaBusqueda {
  origen: string;
  destino: string;
  aerolinea: string;
  vuelo: string;
  mapa: string;
  familia: string;
  salida: string;
  tarifa: string;
  /** Fecha local de la salida en el origen (YYYY-MM-DD). */
  fecha: string;
}

/**
 * Un catálogo propio, aislado de la semilla: dos aeropuertos nuevos, una aerolínea con un
 * modelo, una familia y un mapa (1 fila ejecutiva de 2 asientos y 2 económicas de 3), un vuelo
 * y una salida con 2 cupos en económica y 0 en ejecutiva, y su tarifa. Así una búsqueda entre
 * esos aeropuertos devuelve exactamente esta salida.
 */
export async function crearCadena(c: AppCatalogo): Promise<CadenaBusqueda> {
  const ciudad = (
    await c
      .admin('post', `${ADMIN}/cities`, { country: 'EC', name: `Ciudad ${sufijo()}` })
      .expect(201)
  ).body.id as string;
  const origen = await codigos.aeropuerto(c.prisma);
  let destino = await codigos.aeropuerto(c.prisma);
  while (destino === origen) destino = await codigos.aeropuerto(c.prisma);
  for (const codigo of [origen, destino]) {
    await c
      .admin('post', `${ADMIN}/airports`, {
        code: codigo,
        name: `Aeropuerto ${codigo}`,
        cityId: ciudad,
      })
      .expect(201);
  }
  const aerolinea = await codigos.aerolinea(c.prisma);
  await c
    .admin('post', `${ADMIN}/airlines`, { code: aerolinea, name: 'Aerolínea de búsqueda' })
    .expect(201);
  const modelo = await codigos.modelo(c.prisma);
  await c
    .admin('post', `${ADMIN}/aircraft-models`, { code: modelo, name: 'Modelo de búsqueda' })
    .expect(201);
  const familia = (
    await c
      .admin('post', `${ADMIN}/fare-families`, {
        airline: aerolinea,
        cabinClass: 'ECONOMY',
        code: 'BUSCA',
        name: 'Busca',
        changeable: false,
      })
      .expect(201)
  ).body.id as string;
  const asientos = (letras: string) =>
    [...letras].map((letter, i) => ({
      letter,
      position: i === 0 ? 'WINDOW' : i === letras.length - 1 ? 'WINDOW' : 'AISLE',
    }));
  const mapa = (
    await c
      .admin('post', `${ADMIN}/seat-maps`, {
        airline: aerolinea,
        aircraftModel: modelo,
        name: `Mapa ${sufijo()}`,
        rows: [
          { number: 1, cabinClass: 'BUSINESS', seats: asientos('AC') },
          { number: 2, cabinClass: 'ECONOMY', extraLegroom: true, seats: asientos('ABC') },
          { number: 3, cabinClass: 'ECONOMY', emergencyExit: true, seats: asientos('ABC') },
        ],
      })
      .expect(201)
  ).body.id as string;
  await c
    .admin('post', `${ADMIN}/flights`, {
      marketingCarrier: aerolinea,
      number: '777',
      origin: origen,
      destination: destino,
    })
    .expect(201);
  const vuelo = `${aerolinea}777`;
  // 15:00 UTC son las 10:00 en Ecuador continental: la fecha local es la misma que la UTC
  const salidaCreada = await c
    .admin('post', `${ADMIN}/departures`, {
      flightNumber: vuelo,
      seatMapId: mapa,
      scheduledDeparture: enDias(20, 15),
      scheduledArrival: enDias(20, 16),
      cabins: [
        { cabinClass: 'ECONOMY', totalSeats: 2 },
        { cabinClass: 'BUSINESS', totalSeats: 0 },
      ],
    })
    .expect(201);
  const tarifa = (
    await c
      .admin('post', `${ADMIN}/fares`, {
        departureId: salidaCreada.body.id,
        fareFamilyId: familia,
        currency: 'USD',
        extraBagPrice: '20',
        prices: [
          { passengerType: 'ADULT', baseFare: '50.10', taxes: '10.20' },
          { passengerType: 'CHILD', baseFare: '40.00', taxes: '8.00' },
          { passengerType: 'INFANT', baseFare: '5.00', taxes: '1.00' },
        ],
      })
      .expect(201)
  ).body.id as string;

  return {
    origen,
    destino,
    aerolinea,
    vuelo,
    mapa,
    familia,
    salida: salidaCreada.body.id,
    tarifa,
    fecha: salidaCreada.body.departureDate,
  };
}

/**
 * Una reserva confirmada con el asiento `asiento` (ej. 2B) asignado en la salida, como la
 * dejará la fase 7. Queda en la base; `liberarReserva` la cancela al final de la prueba.
 */
export async function reservarAsiento(
  prisma: PrismaService,
  salidaId: string,
  asiento: string,
): Promise<string> {
  const pnr = sufijo().slice(0, 6);
  const [{ reserva }] = await prisma.db.$queryRaw<Array<{ reserva: string }>>`
    WITH vp AS (SELECT vp.id, vp.mapa_asientos_id, v.aerolinea_id
                  FROM vuelos.vuelo_programado vp JOIN vuelos.vuelo v ON v.id = vp.vuelo_id
                 WHERE vp.id = ${salidaId}::uuid),
    o AS (INSERT INTO vuelos.oferta_cabecera (aerolinea_id, huella_dispositivo, fecha_expiracion)
          SELECT aerolinea_id, 'e2e-reserva', now() + interval '1 hour' FROM vp RETURNING id),
    r AS (INSERT INTO vuelos.retencion_cabecera (oferta_id, id_propietario, moneda_id, estado, fecha_expiracion, fecha_cierre)
          SELECT o.id, 'e2e-busqueda', (SELECT id FROM vuelos.moneda WHERE codigo_iso = 'USD'), 'CONSUMIDA',
                 now() + interval '15 minutes', now() FROM o RETURNING id),
    b AS (INSERT INTO vuelos.reserva_cabecera (retencion_id, pnr, estado)
          SELECT r.id, ${pnr}, 'CONFIRMADA' FROM r RETURNING id)
    SELECT id AS reserva FROM b`;
  const [{ pasajero }] = await prisma.db.$queryRaw<Array<{ pasajero: bigint }>>`
    INSERT INTO vuelos.reserva_detalle_pasajero
      (reserva_id, codigo_pasajero, tipo_pasajero, nombres, apellidos, tipo_documento, numero_documento,
       pais_nacionalidad_id, fecha_nacimiento, genero, correo, telefono)
    VALUES (${reserva}::uuid, 'PAX1', 'ADULTO', 'Ana', 'Prueba', 'CEDULA', '1710034065',
            (SELECT id FROM vuelos.pais WHERE codigo_iso2 = 'EC'), '1990-01-01', 'F', 'ana@e2e.quinde.example', '+593991234567')
    RETURNING id AS pasajero`;
  await prisma.db.$executeRaw`
    INSERT INTO vuelos.reserva_detalle_asiento (pasajero_id, vuelo_programado_id, asiento_id)
    SELECT ${pasajero}, ${salidaId}::uuid, a.id
      FROM vuelos.asiento a
      JOIN vuelos.mapa_asientos_detalle f ON f.id = a.mapa_asientos_detalle_id
      JOIN vuelos.vuelo_programado vp ON vp.mapa_asientos_id = f.mapa_asientos_id
     WHERE vp.id = ${salidaId}::uuid AND f.numero_fila::text || a.letra = ${asiento}`;
  return reserva;
}

/** Libera el asiento y cancela la reserva de prueba (no se borra: queda en la base). */
export async function liberarReserva(prisma: PrismaService, reservaId: string): Promise<void> {
  await prisma.db.$executeRaw`
    UPDATE vuelos.reserva_detalle_asiento SET fecha_liberacion = now()
     WHERE pasajero_id IN (SELECT id FROM vuelos.reserva_detalle_pasajero WHERE reserva_id = ${reservaId}::uuid)`;
  await prisma.db.$executeRaw`
    UPDATE vuelos.reserva_cabecera SET estado = 'CANCELADA' WHERE id = ${reservaId}::uuid`;
}

/** Da de baja la cadena en orden inverso, como cualquier catálogo de prueba. */
export async function darDeBajaCadena(c: AppCatalogo, k: CadenaBusqueda): Promise<void> {
  const ciudad = (await c.admin('get', `${ADMIN}/airports/${k.origen}`).expect(200)).body.cityId;
  const modelo = (await c.admin('get', `${ADMIN}/seat-maps/${k.mapa}`).expect(200)).body
    .aircraftModel;
  for (const ruta of [
    `fares/${k.tarifa}`,
    `departures/${k.salida}`,
    `flights/${k.vuelo}`,
    `seat-maps/${k.mapa}`,
    `fare-families/${k.familia}`,
    `aircraft-models/${modelo}`,
    `airlines/${k.aerolinea}`,
    `airports/${k.origen}`,
    `airports/${k.destino}`,
    `cities/${ciudad}`,
  ]) {
    await c.admin('delete', `${ADMIN}/${ruta}`).expect(204);
  }
}
