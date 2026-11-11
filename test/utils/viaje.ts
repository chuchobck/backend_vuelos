import { INestApplication } from '@nestjs/common';
import { fechaEn } from './busqueda';
import { RelojDePrueba } from './reloj';
import {
  buscarYRetener,
  con,
  cuerpoReserva,
  pasajero,
  referenciaPago,
  reservar,
  RESERVAS,
} from './reserva';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- cuerpos JSON de la API
export type Cuerpo = Record<string, any>;
export type Cliente = { id: string; token: string };

const HORA = 3_600_000;

/** La salida programada del primer segmento del itinerario `i` de la reserva. */
export const salidaDe = (detalle: Cuerpo, i = 0) =>
  new Date(detalle.itineraries[i].segments[0].departure.at);

/** El primer segmento del itinerario `i` de la reserva. */
export const segmentoDe = (detalle: Cuerpo, i = 0): Cuerpo => detalle.itineraries[i].segments[0];

/**
 * Una reserva confirmada UIO-GYE directa (o ida y vuelta) sobre la semilla, dentro de `dias` días.
 * El reloj tiene que estar en el presente: el hold vence con él.
 */
export async function reservaConfirmada(
  app: INestApplication,
  cliente: Cliente,
  dias: number,
  pasajeros: object[] = [pasajero('ADULT', 1)],
  opciones: { vuelta?: number } = {},
): Promise<Cuerpo> {
  const tipos = pasajeros.map((p) => (p as { passengerType: string }).passengerType);
  const breakdown = {
    adults: tipos.filter((t) => t === 'ADULT').length,
    infants: tipos.filter((t) => t === 'INFANT').length,
  };
  const tramos: Array<[string, string, string]> = [['UIO', 'GYE', fechaEn(dias)]];
  if (opciones.vuelta) tramos.push(['GYE', 'UIO', fechaEn(dias + opciones.vuelta)]);
  const retenido = await buscarYRetener(app, cliente.token, tramos, breakdown, { directa: true });
  const respuesta = await reservar(
    app,
    cliente.token,
    cuerpoReserva(retenido.holdId, pasajeros, referenciaPago()),
  );
  expect(respuesta.status).toBe(201);
  return respuesta.body;
}

/**
 * La misma reserva con el check-in hecho por su dueño (el reloj queda 24 h antes de la salida) y
 * sus pases de abordar.
 */
export async function reservaConCheckin(
  app: INestApplication,
  reloj: RelojDePrueba,
  cliente: Cliente,
  dias: number,
  pasajeros: object[] = [pasajero('ADULT', 1)],
): Promise<{ reserva: Cuerpo; pases: Cuerpo[] }> {
  reloj.alPresente();
  const reserva = await reservaConfirmada(app, cliente, dias, pasajeros);
  reloj.fijar(new Date(salidaDe(reserva).getTime() - 24 * HORA));
  await con(app, cliente.token)('post', `${RESERVAS}/${reserva.bookingId}/check-in`).expect(200);
  const pases = await con(app, cliente.token)(
    'get',
    `${RESERVAS}/${reserva.bookingId}/boarding-passes`,
  ).expect(200);
  return { reserva, pases: pases.body.boardingPasses };
}
