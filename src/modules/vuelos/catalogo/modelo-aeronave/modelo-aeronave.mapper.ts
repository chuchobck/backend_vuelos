import { ModeloAeronaveRespuestaDto } from './dto/modelo-aeronave.dto';
import { FilaModeloAeronave } from './modelo-aeronave.repository';

export function aModeloAeronaveRespuesta(fila: FilaModeloAeronave): ModeloAeronaveRespuestaDto {
  return { code: fila.codigo_iata, name: fila.nombre, active: fila.activo };
}
