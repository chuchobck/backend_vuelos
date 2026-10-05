import { CABINA } from '../../compartido/enums';
import { aTextoDecimal } from '../../compartido/formatos-salida';
import { FamiliaTarifaRespuestaDto } from './dto/familia-tarifa.dto';
import { FilaFamiliaTarifa } from './familia-tarifa.repository';

export function aFamiliaTarifaRespuesta(fila: FilaFamiliaTarifa): FamiliaTarifaRespuestaDto {
  return {
    id: fila.id_publico,
    airline: fila.aerolinea.codigo_iata,
    cabinClass: CABINA.aContrato(fila.clase_cabina),
    code: fila.codigo,
    name: fila.nombre,
    changeable: fila.es_cambiable,
    cancellationPenaltyPercent: aTextoDecimal(fila.porcentaje_penalidad_cancelacion),
    // Como dice el COMMENT de la columna: isRefundable es (porcentaje < 100)
    refundable: fila.porcentaje_penalidad_cancelacion.lessThan(100),
    personalItemIncluded: fila.incluye_articulo_personal,
    carryOnBagsIncluded: fila.equipaje_mano_incluido,
    checkedBagsIncluded: fila.equipaje_bodega_incluido,
    maxExtraBags: fila.maximo_equipaje_adicional,
    active: fila.activo,
  };
}
