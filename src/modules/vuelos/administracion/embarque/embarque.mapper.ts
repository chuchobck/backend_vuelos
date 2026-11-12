import { CABINA, ESTADO_VUELO } from '../../compartido/enums';
import { aFecha, aInstante } from '../../compartido/formatos-salida';
import { AbordajeDto, ManifiestoDto, PasajeroAbordadoDto } from './dto/embarque.dto';
import { Abordaje, Manifiesto, PasajeroAbordado } from './embarque.modelo';

const aPasajero = (p: PasajeroAbordado): PasajeroAbordadoDto => ({
  passengerId: p.codigo,
  firstName: p.nombres,
  lastName: p.apellidos,
});

export function aAbordaje(abordaje: Abordaje): AbordajeDto {
  return {
    result: 'BOARDED',
    departureId: abordaje.salida.id,
    flightNumber: abordaje.salida.numeroVuelo,
    seat: abordaje.asiento,
    boardingGroup: abordaje.grupo,
    boardingPosition: abordaje.posicion,
    boardedAt: aInstante(abordaje.abordado),
    passenger: aPasajero(abordaje.pasajero),
    infants: abordaje.infantes.map(aPasajero),
  };
}

export function aManifiesto(manifiesto: Manifiesto): ManifiestoDto {
  const { salida, asientos, infantes } = manifiesto;
  return {
    departureId: salida.id,
    flightNumber: salida.numeroVuelo,
    date: aFecha(salida.fechaSalida),
    origin: salida.origen,
    destination: salida.destino,
    status: ESTADO_VUELO.aContrato(salida.estado),
    gate: salida.puerta,
    counts: {
      sold: asientos.length,
      checkedIn: asientos.filter((a) => a.estado === 'CHECKED_IN' || a.estado === 'BOARDED').length,
      boarded: asientos.filter((a) => a.estado === 'BOARDED').length,
      infants: {
        sold: infantes.vendidos,
        checkedIn: infantes.registrados,
        boarded: infantes.abordados,
      },
    },
    seats: asientos.map((a) => ({
      seat: a.asiento,
      cabinClass: CABINA.aContrato(a.cabina),
      pnr: a.pnr,
      passengerId: a.codigoPasajero,
      status: a.estado,
      boardingGroup: a.grupo,
      boardedAt: aInstante(a.abordado),
    })),
  };
}
