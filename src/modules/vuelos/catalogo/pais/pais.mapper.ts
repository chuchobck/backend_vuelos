import { PaisRespuestaDto } from './dto/pais.dto';
import { FilaPais } from './pais.repository';

export function aPaisRespuesta(fila: FilaPais): PaisRespuestaDto {
  return { code: fila.codigo_iso2, iso3: fila.codigo_iso3, name: fila.nombre, active: fila.activo };
}
