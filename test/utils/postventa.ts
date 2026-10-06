import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../src/prisma/prisma.service';
import { CadenaBusqueda } from './busqueda';
import { ADMIN, AppCatalogo, enDias } from './catalogo';
import { con, RESERVAS } from './reserva';

/**
 * Una salida más del vuelo de la cadena, `dias` días adelante a las 15:00 UTC, con `cupo`
 * asientos en económica y la tarifa de la familia de la cadena con esos precios de adulto.
 */
export async function agregarSalida(
  c: AppCatalogo,
  k: CadenaBusqueda,
  dias: number,
  cupo: number,
  adulto: { baseFare: string; taxes: string },
): Promise<{ salida: string; fecha: string }> {
  const salida = await c
    .admin('post', `${ADMIN}/departures`, {
      flightNumber: k.vuelo,
      seatMapId: k.mapa,
      scheduledDeparture: enDias(dias, 15),
      scheduledArrival: enDias(dias, 16),
      cabins: [
        { cabinClass: 'ECONOMY', totalSeats: cupo },
        { cabinClass: 'BUSINESS', totalSeats: 0 },
      ],
    })
    .expect(201);
  await c
    .admin('post', `${ADMIN}/fares`, {
      departureId: salida.body.id,
      fareFamilyId: k.familia,
      currency: 'USD',
      extraBagPrice: '20',
      changeFee: '5.00',
      prices: [
        { passengerType: 'ADULT', ...adulto },
        { passengerType: 'CHILD', baseFare: '40.00', taxes: '8.00' },
        { passengerType: 'INFANT', baseFare: '5.00', taxes: '1.00' },
      ],
    })
    .expect(201);
  return { salida: salida.body.id, fecha: salida.body.departureDate };
}

/**
 * Cancela (cotización y cancelación) las reservas CONFIRMED del usuario, para que su cupo vuelva
 * y el catálogo de prueba se pueda dar de baja. Las demás quedan como están.
 */
export async function cancelarReservasDe(app: INestApplication, token: string): Promise<number> {
  let cursor: string | undefined;
  let canceladas = 0;
  do {
    const pagina = await con(app, token)(
      'get',
      `${RESERVAS}?status=CONFIRMED&limit=50${cursor ? `&cursor=${cursor}` : ''}`,
    ).expect(200);
    for (const { bookingId } of pagina.body.items as Array<{ bookingId: string }>) {
      const cotizacion = await con(app, token)(
        'get',
        `${RESERVAS}/${bookingId}/cancellation-quote`,
      );
      if (cotizacion.status !== 200) continue;
      const respuesta = await con(app, token)('post', `${RESERVAS}/${bookingId}/cancel`)
        .set('Idempotency-Key', randomUUID())
        .send({ quoteId: cotizacion.body.quoteId });
      if (respuesta.status === 200 || respuesta.status === 202) canceladas++;
    }
    cursor = pagina.body.nextCursor;
  } while (cursor);
  return canceladas;
}

/** Filas de una reserva que cuentan en la base: líneas vigentes, asientos, maletas y boletos. */
export async function estadoEnBase(prisma: PrismaService, reservaId: string) {
  const [fila] = await prisma.db.$queryRaw<
    Array<{ estado: string; lineas: number; asientos: number; maletas: number; boletos: string }>
  >`
    SELECT rc.estado::text AS estado,
           (SELECT count(*)::int FROM vuelos.reserva_detalle_itinerario r
             WHERE r.reserva_id = rc.id AND r.vigente) AS lineas,
           (SELECT count(*)::int FROM vuelos.reserva_detalle_asiento a
              JOIN vuelos.reserva_detalle_pasajero p ON p.id = a.pasajero_id
             WHERE p.reserva_id = rc.id AND a.fecha_liberacion IS NULL) AS asientos,
           (SELECT COALESCE(SUM(q.cantidad), 0)::int FROM vuelos.reserva_detalle_equipaje q
              JOIN vuelos.reserva_detalle_pago g ON g.id = q.pago_id
              JOIN vuelos.reserva_detalle_pasajero p ON p.id = q.pasajero_id
             WHERE p.reserva_id = rc.id AND g.estado <> 'RECHAZADO') AS maletas,
           (SELECT string_agg(b.estado::text, ',' ORDER BY b.estado::text)
              FROM vuelos.boleto_cabecera b
              JOIN vuelos.reserva_detalle_pasajero p ON p.id = b.pasajero_id
             WHERE p.reserva_id = rc.id) AS boletos
      FROM vuelos.reserva_cabecera rc
     WHERE rc.id = ${reservaId}::uuid`;
  return fila;
}
