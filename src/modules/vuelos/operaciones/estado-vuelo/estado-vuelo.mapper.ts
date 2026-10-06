import { ESTADO_VUELO } from '../../compartido/enums';
import { aFecha, aInstante } from '../../compartido/formatos-salida';
import { EstadoVueloDto, ExtremoEstadoDto } from './dto/estado-vuelo.dto';
import { EstadoVuelo, ExtremoEstado } from './estado-vuelo.modelo';

const aExtremo = (extremo: ExtremoEstado): ExtremoEstadoDto => ({
  iataCode: extremo.iata,
  terminal: extremo.terminal,
  scheduledAt: aInstante(extremo.programada),
  estimatedAt: aInstante(extremo.estimada),
  actualAt: aInstante(extremo.real),
});

export function aEstadoVuelo(estado: EstadoVuelo): EstadoVueloDto {
  return {
    flightNumber: estado.numeroVuelo,
    date: aFecha(estado.fecha),
    marketingCarrier: estado.comercializa,
    operatingCarrier: estado.opera,
    departure: aExtremo(estado.salida),
    arrival: aExtremo(estado.llegada),
    aircraft: estado.aeronave,
    status: ESTADO_VUELO.aContrato(estado.estado),
  };
}
