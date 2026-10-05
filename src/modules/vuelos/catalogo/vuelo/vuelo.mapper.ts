import { VueloRespuestaDto } from './dto/vuelo.dto';
import { FilaVuelo, numeroVueloDe } from './vuelo.repository';

export function aVueloRespuesta(fila: FilaVuelo): VueloRespuestaDto {
  return {
    flightNumber: numeroVueloDe(fila),
    marketingCarrier: fila.comercializa.codigo_iata,
    operatingCarrier: fila.opera.codigo_iata,
    origin: fila.origen.codigo_iata,
    destination: fila.destino.codigo_iata,
    active: fila.activo,
  };
}
