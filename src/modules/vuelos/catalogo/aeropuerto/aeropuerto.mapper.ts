import { FilaAeropuerto } from './aeropuerto.repository';
import { AeropuertoRespuestaDto } from './dto/aeropuerto.dto';

export function aAeropuertoRespuesta(fila: FilaAeropuerto): AeropuertoRespuestaDto {
  return {
    code: fila.codigo_iata,
    name: fila.nombre,
    cityId: fila.ciudad.id_publico,
    cityName: fila.ciudad.nombre,
    country: fila.ciudad.pais.codigo_iso2,
    active: fila.activo,
  };
}
