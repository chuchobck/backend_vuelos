import { ESTADO_VUELO } from '../../compartido/enums';
import { aHoraLocal } from '../../compartido/fechas';
import { aFecha } from '../../compartido/formatos-salida';
import { SalidasPublicasDto } from './dto/tablero-salidas.dto';
import { TableroDeSalidas } from './tablero-salidas.modelo';

/** Las horas van en la hora local del aeropuerto: es lo que una pantalla muestra. */
export function aSalidasPublicas(tablero: TableroDeSalidas): SalidasPublicasDto {
  const zona = tablero.aeropuerto.zonaHoraria;
  return {
    airport: {
      iataCode: tablero.aeropuerto.iata,
      name: tablero.aeropuerto.nombre,
      city: tablero.aeropuerto.ciudad,
      timeZone: zona,
    },
    date: aFecha(tablero.fecha),
    departures: tablero.salidas.map((s) => ({
      flightNumber: s.numeroVuelo,
      airline: s.aerolinea,
      destination: { iataCode: s.destino, city: s.ciudadDestino },
      scheduledTime: aHoraLocal(s.programada, zona),
      estimatedTime: s.estimada === null ? null : aHoraLocal(s.estimada, zona),
      status: ESTADO_VUELO.aContrato(s.estado),
      terminal: s.terminal,
      gate: s.puerta,
    })),
    ...(tablero.nextCursor === undefined ? {} : { nextCursor: tablero.nextCursor }),
  };
}
