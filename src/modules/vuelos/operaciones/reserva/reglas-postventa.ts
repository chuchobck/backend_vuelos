import { CodigoError, CODIGO_SIN_EQUIVALENTE } from '../../../../common/errores/codigo-error';
import { CodigoErrorV2 } from '../../../../common/errores/codigo-error-v2';
import { ErrorNegocio } from '../../../../common/errores/error-negocio';
import { ESTADO_RESERVA } from '../../compartido/enums';
import { ItinerarioDeReserva, Reserva } from './reserva.modelo';

/**
 * Lo que exigen todas las operaciones de postventa (equipaje, cambio de fecha, cancelación):
 * una reserva CONFIRMADA (con sus boletos emitidos) y vuelos que todavía no salieron. La hora
 * es la del Reloj; `salida_programada` es un instante, así que no depende de la zona horaria
 * del aeropuerto (continente o Galápagos). En v2 el 409 lleva BOOKING_NOT_CONFIRMED, o el
 * `codigoV2` que pase la operación (BOOKING_NOT_CANCELLABLE en la cancelación).
 */
export function exigirConfirmada(
  reserva: Reserva,
  operacion: string,
  codigoV2: CodigoErrorV2 = CodigoErrorV2.BOOKING_NOT_CONFIRMED,
): void {
  if (reserva.estado !== 'CONFIRMADA') {
    throw new ErrorNegocio(
      409,
      CODIGO_SIN_EQUIVALENTE,
      `Booking ${reserva.id} is ${ESTADO_RESERVA.aContrato(reserva.estado)}; ${operacion} ` +
        'needs a CONFIRMED booking with its tickets issued',
      { v2: { code: codigoV2 } },
    );
  }
}

/** 409 FLIGHT_ALREADY_DEPARTED si algún vuelo de esos itinerarios ya salió. */
export function exigirSinDespegar(itinerarios: ItinerarioDeReserva[], ahora: Date): void {
  for (const salida of itinerarios.flatMap((it) => it.salidas)) {
    if (salida.salida <= ahora) {
      throw new ErrorNegocio(
        409,
        CodigoError.FLIGHT_ALREADY_DEPARTED,
        `Flight ${salida.numeroVuelo} of segment ${salida.id} has already departed`,
      );
    }
  }
}

/** El itinerario vigente de la reserva con ese id, o 422 en ese campo. */
export function itinerarioDeLaReserva(
  reserva: Reserva,
  itinerarioId: string,
  campo: string,
): ItinerarioDeReserva {
  const itinerario = reserva.itinerarios.find((it) => it.id === itinerarioId.toLowerCase());
  if (!itinerario) {
    throw new ErrorNegocio(
      422,
      CODIGO_SIN_EQUIVALENTE,
      `${campo}: is not an itinerary of this booking`,
      { invalidParams: [{ name: campo, reason: 'is not an itinerary of this booking' }] },
    );
  }
  return itinerario;
}
