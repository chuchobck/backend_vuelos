import { CABINA, TIPO_PASAJERO } from '../../compartido/enums';
import { aTextoDecimal } from '../../compartido/formatos-salida';
import { TarifaRespuestaDto } from './dto/tarifa.dto';
import { FilaTarifa } from './tarifa.repository';

export function aTarifaRespuesta(fila: FilaTarifa): TarifaRespuestaDto {
  const vuelo = fila.vuelo_programado.vuelo;
  return {
    id: fila.id_publico,
    departureId: fila.vuelo_programado.id,
    flightNumber: `${vuelo.aerolinea_vuelo_aerolinea_idToaerolinea.codigo_iata}${vuelo.numero}`,
    fareFamilyId: fila.familia_tarifa.id_publico,
    fareBrand: fila.familia_tarifa.codigo,
    cabinClass: CABINA.aContrato(fila.familia_tarifa.clase_cabina),
    currency: fila.moneda.codigo_iso,
    extraBagPrice: aTextoDecimal(fila.precio_equipaje_adicional),
    changeFee: aTextoDecimal(fila.cargo_cambio),
    prices: fila.tarifa_detalle.map((precio) => ({
      passengerType: TIPO_PASAJERO.aContrato(precio.tipo_pasajero),
      baseFare: aTextoDecimal(precio.tarifa_base),
      taxes: aTextoDecimal(precio.impuestos),
      // El total no se guarda (3FN): la suma se hace en Decimal, sin pasar por number
      total: aTextoDecimal(precio.tarifa_base.plus(precio.impuestos)),
    })),
    active: fila.activo,
  };
}
