import { ESTADO_RESERVA, ESTADO_VUELO, TIPO_PASAJERO } from '../../compartido/enums';
import { aInstante } from '../../compartido/formatos-salida';
import { Ventana } from '../checkin/checkin.modelo';
import { SesionKioskoDto, VENTANAS } from './dto/kiosko.dto';
import { ReservaEnKiosko } from './kiosko.modelo';

const VENTANA: Record<Ventana, (typeof VENTANAS)[number]> = {
  abierta: 'OPEN',
  'aun-no': 'NOT_YET_OPEN',
  cerrada: 'CLOSED',
};

/**
 * Lo que el kiosko muestra de una reserva: los vuelos con sus horarios, el asiento y el estado
 * de check-in de cada pasajero en cada vuelo, y los nombres. Nada más sale de aquí: ni
 * documento, ni correo, ni teléfono, ni precios, ni boletos, ni historial, ni el PNR.
 */
export function aSesionKiosko(abierta: ReservaEnKiosko): SesionKioskoDto {
  const { reserva, checkin } = abierta;
  const vuelos = [...reserva.itinerarios]
    .sort((a, b) => a.orden - b.orden)
    .flatMap((itinerario) => itinerario.salidas);
  return {
    kioskToken: abierta.token,
    expiresAt: aInstante(abierta.vence),
    booking: {
      bookingId: reserva.id,
      status: ESTADO_RESERVA.aContrato(reserva.estado),
      passengers: reserva.pasajeros.map((p) => ({
        passengerId: p.codigo,
        passengerType: TIPO_PASAJERO.aContrato(p.tipo),
        firstName: p.nombres,
        lastName: p.apellidos,
      })),
      flights: vuelos.map((vuelo) => {
        const ventana = checkin.ventanas.find((v) => v.salidaId === vuelo.id)!;
        return {
          segmentId: vuelo.id,
          flightNumber: vuelo.numeroVuelo,
          origin: vuelo.origen,
          destination: vuelo.destino,
          departureAt: aInstante(vuelo.salida),
          arrivalAt: aInstante(vuelo.llegada),
          departureTerminal: vuelo.terminalSalida,
          status: ESTADO_VUELO.aContrato(vuelo.estado),
          checkIn: {
            window: VENTANA[ventana.estado],
            opensAt: aInstante(ventana.abre),
            closesAt: aInstante(ventana.cierra),
          },
          passengers: checkin.resultado.pasajeros.map((p) => {
            const tramo = p.tramos.find((t) => t.salidaId === vuelo.id)!;
            return { passengerId: p.codigo, seat: tramo.asiento, checkInStatus: tramo.estado };
          }),
        };
      }),
    },
  };
}
