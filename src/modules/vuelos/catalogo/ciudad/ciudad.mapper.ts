import { FilaCiudad } from './ciudad.repository';
import { CiudadRespuestaDto } from './dto/ciudad.dto';

export function aCiudadRespuesta(fila: FilaCiudad): CiudadRespuestaDto {
  return {
    id: fila.id_publico,
    country: fila.pais.codigo_iso2,
    name: fila.nombre,
    timeZone: fila.zona_horaria,
    active: fila.activo,
  };
}
