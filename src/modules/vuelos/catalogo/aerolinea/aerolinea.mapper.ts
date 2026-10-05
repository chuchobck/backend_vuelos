import { FilaAerolinea } from './aerolinea.repository';
import { AerolineaRespuestaDto } from './dto/aerolinea.dto';

export function aAerolineaRespuesta(fila: FilaAerolinea): AerolineaRespuestaDto {
  return {
    code: fila.codigo_iata,
    name: fila.nombre,
    ticketPrefix: fila.prefijo_boleto,
    active: fila.activo,
  };
}
