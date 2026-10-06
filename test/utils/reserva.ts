import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { crearUsuario, iniciarSesion } from './auth';
import { HUELLA } from './busqueda';

export const RESERVAS = '/flights/v1/bookings';
export const HOLD = '/flights/v1/offers/hold';

type Metodo = 'get' | 'post' | 'delete' | 'patch';

/** Petición con un token (o sin él). */
export function con(app: INestApplication, token?: string) {
  return (metodo: Metodo, ruta: string) => {
    const prueba = request(app.getHttpServer())[metodo](ruta);
    return token ? prueba.set('Authorization', `Bearer ${token}`) : prueba;
  };
}

/** Un cliente nuevo (creado con el service, sin gastar límites) y su token. */
export async function nuevoCliente(app: INestApplication): Promise<{ id: string; token: string }> {
  const usuario = await crearUsuario(app);
  return { id: usuario.id, token: (await iniciarSesion(app, usuario)).access_token };
}

/** Distinto en cada corrida; dentro de ella, `n` distinto da una cédula distinta. */
const DESPLAZAMIENTO_CEDULA = Math.floor(Math.random() * 900_000);

/** Cédula ecuatoriana válida de Pichincha (17), con su dígito verificador. */
export function cedula(serie: number): string {
  const base = `171${String(serie % 1_000_000).padStart(6, '0')}`;
  let suma = 0;
  for (let i = 0; i < 9; i++) {
    let producto = Number(base[i]) * (i % 2 === 0 ? 2 : 1);
    if (producto > 9) producto -= 9;
    suma += producto;
  }
  return `${base}${(10 - (suma % 10)) % 10}`;
}

/** Una fecha `YYYY-MM-DD` de hace `anios` años y `dias` días. */
function haceTiempo(anios: number, dias = 0): string {
  const fecha = new Date();
  fecha.setUTCFullYear(fecha.getUTCFullYear() - anios);
  fecha.setUTCDate(fecha.getUTCDate() - dias);
  return fecha.toISOString().slice(0, 10);
}

const NACIMIENTOS = {
  ADULT: '1990-04-15',
  YOUTH: haceTiempo(15),
  CHILD: haceTiempo(8),
  // Seis meses: sigue teniendo menos de 2 años en cualquier vuelo de la semilla (90 días)
  INFANT: haceTiempo(0, 180),
};

export type TipoPasajero = keyof typeof NACIMIENTOS;

/** Un PassengerItem válido del tipo indicado; `n` lo distingue (passengerId y cédula). */
export function pasajero(tipo: TipoPasajero, n: number, cambios: object = {}) {
  return {
    passengerId: `${tipo.slice(0, 3)}${n}`,
    passengerType: tipo,
    firstName: 'Ana María',
    lastName: "D'Alessio Pérez",
    documentType: 'NATIONAL_ID',
    documentNumber: cedula(DESPLAZAMIENTO_CEDULA + n),
    nationality: 'EC',
    birthDate: NACIMIENTOS[tipo],
    gender: 'F',
    contact: { email: `pasajero${n}@e2e.quinde.example`, phone: '+593991234567' },
    ...cambios,
  };
}

/** Una referencia de la Payment API simulada: aprobada, pendiente o rechazada. */
export function referenciaPago(tipo: 'OK' | 'PEND' | 'REJ' = 'OK'): string {
  return `PAY-${tipo}-${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`;
}

export interface Retenido {
  holdId: string;
  oferta: OfertaDePrueba;
  /** El total congelado del hold (lockedPrice). */
  precio: { currency: string; baseFare: string; taxes: string; total: string };
}

export interface OfertaDePrueba {
  offerId: string;
  itineraries: Array<{
    itineraryId: string;
    segments: Array<{ segmentId: string }>;
    pricingOptions: Array<{ cabinClass: string; fareBrand: string }>;
  }>;
}

/**
 * Busca y retiene la primera oferta (o la primera directa) con la primera opción de cada
 * itinerario. `tramos` son [origen, destino, fecha YYYY-MM-DD].
 */
export async function buscarYRetener(
  app: INestApplication,
  token: string,
  tramos: Array<[string, string, string]>,
  pasajeros: { adults?: number; youths?: number; children?: number; infants?: number },
  opciones: { directa?: boolean; fareBrand?: string } = {},
): Promise<Retenido> {
  const busqueda = await request(app.getHttpServer())
    .post('/flights/v1/search')
    .set('X-Device-Fingerprint', HUELLA)
    .send({
      itineraries: tramos.map(([origin, destination, departureDate]) => ({
        origin,
        destination,
        departureDate,
      })),
      passengers: pasajeros,
    })
    .expect(200);
  const ofertas: OfertaDePrueba[] = busqueda.body.offers;
  const conFamilia = (o: OfertaDePrueba) =>
    !opciones.fareBrand ||
    o.itineraries.every((it) => it.pricingOptions.some((p) => p.fareBrand === opciones.fareBrand));
  const oferta = ofertas.find(
    (o) =>
      conFamilia(o) && (!opciones.directa || o.itineraries.every((it) => it.segments.length === 1)),
  );
  if (!oferta) throw new Error('La búsqueda no devolvió una oferta para retener');
  const hold = await con(app, token)('post', HOLD)
    .set('Idempotency-Key', randomUUID())
    .send({
      offerId: oferta.offerId,
      itinerarySelections: oferta.itineraries.map((it) => {
        const opcion =
          it.pricingOptions.find((p) => p.fareBrand === opciones.fareBrand) ?? it.pricingOptions[0];
        return {
          itineraryId: it.itineraryId,
          cabinClass: opcion.cabinClass,
          fareBrand: opcion.fareBrand,
        };
      }),
      passengersBreakdown: pasajeros,
    })
    .expect(201);
  return { holdId: hold.body.holdId, oferta, precio: hold.body.lockedPrice };
}

export function reservar(
  app: INestApplication,
  token: string,
  cuerpo: object,
  clave: string | null = randomUUID(),
): request.Test {
  const prueba = con(app, token)('post', RESERVAS);
  return (clave === null ? prueba : prueba.set('Idempotency-Key', clave)).send(cuerpo);
}

/** El cuerpo de POST /bookings con esos pasajeros y una referencia (aprobada por defecto). */
export const cuerpoReserva = (
  holdId: string,
  pasajeros: object[],
  referencia = referenciaPago(),
) => ({
  holdId,
  passengers: pasajeros,
  payment: { paymentReference: referencia },
});

/** Cupo de una cabina y lo que retienen o consumieron los holds que pasan por ella. */
export async function cupoDe(
  prisma: PrismaService,
  salida: string,
  cabina = 'ECONOMICA',
): Promise<{ totales: number; disponibles: number; tomados: number }> {
  const [fila] = await prisma.db.$queryRaw<
    Array<{ totales: number; disponibles: number; tomados: number }>
  >`
    SELECT ic.cupos_totales::int AS totales, ic.cupos_disponibles::int AS disponibles,
           COALESCE((SELECT SUM(r.adultos + r.jovenes + r.ninos)
                       FROM vuelos.retencion_cabecera r
                       JOIN vuelos.retencion_detalle d  ON d.retencion_id = r.id
                       JOIN vuelos.itinerario_detalle i ON i.itinerario_id = d.itinerario_id
                       JOIN vuelos.familia_tarifa f     ON f.id = d.familia_tarifa_id
                      WHERE (r.estado = 'RETENIDA'
                             OR (r.estado = 'CONSUMIDA' AND NOT EXISTS (
                                   SELECT 1 FROM vuelos.reserva_cabecera rc
                                    WHERE rc.retencion_id = r.id AND rc.estado = 'FALLIDA')))
                        AND i.vuelo_programado_id = ic.vuelo_programado_id
                        AND f.clase_cabina = ic.clase_cabina), 0)::int AS tomados
      FROM vuelos.inventario_cabina ic
     WHERE ic.vuelo_programado_id = ${salida}::uuid AND ic.clase_cabina::text = ${cabina}`;
  return fila;
}

/** Los asientos ocupados de una salida, con el número del contrato (12A). */
export async function asientosOcupados(prisma: PrismaService, salida: string): Promise<string[]> {
  const filas = await prisma.db.$queryRaw<Array<{ numero: string }>>`
    SELECT f.numero_fila::text || a.letra AS numero
      FROM vuelos.reserva_detalle_asiento ra
      JOIN vuelos.asiento a               ON a.id = ra.asiento_id
      JOIN vuelos.mapa_asientos_detalle f ON f.id = a.mapa_asientos_detalle_id
     WHERE ra.vuelo_programado_id = ${salida}::uuid AND ra.fecha_liberacion IS NULL
     ORDER BY f.numero_fila, a.letra`;
  return filas.map((f) => f.numero);
}

/** Los asientos libres de una cabina de la salida, por fila y letra (el orden de la API). */
export async function asientosLibres(
  prisma: PrismaService,
  salida: string,
  cabina = 'ECONOMICA',
): Promise<string[]> {
  const filas = await prisma.db.$queryRaw<Array<{ numero: string }>>`
    SELECT f.numero_fila::text || a.letra AS numero
      FROM vuelos.vuelo_programado vp
      JOIN vuelos.mapa_asientos_detalle f ON f.mapa_asientos_id = vp.mapa_asientos_id
      JOIN vuelos.asiento a               ON a.mapa_asientos_detalle_id = f.id
     WHERE vp.id = ${salida}::uuid AND f.clase_cabina::text = ${cabina}
       AND NOT EXISTS (SELECT 1 FROM vuelos.reserva_detalle_asiento o
                        WHERE o.vuelo_programado_id = vp.id AND o.asiento_id = a.id
                          AND o.fecha_liberacion IS NULL)
     ORDER BY f.numero_fila, a.letra`;
  return filas.map((f) => f.numero);
}
