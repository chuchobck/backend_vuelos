import { aInstante, aTextoDecimal } from '../../compartido/formatos-salida';
import { aSegmento } from '../busqueda/busqueda.mapper';
import { OpcionCambioDto } from './dto/cambio-fecha.dto';
import { OpcionCambio } from './cambio-fecha.modelo';

export function aOpcionCambio(opcion: OpcionCambio): OpcionCambioDto {
  return {
    changeOfferId: opcion.id,
    expiresAt: aInstante(opcion.vence),
    // layoverMinutes solo entre vuelos del mismo itinerario (los del mismo día seguidos)
    segments: opcion.salidas.map((salida, i) => {
      const anterior = opcion.salidas[i - 1];
      return aSegmento(
        salida,
        anterior && anterior.destino === salida.origen && salida.salida > anterior.llegada
          ? anterior
          : undefined,
      );
    }),
    priceDifference: {
      fareDifference: aTextoDecimal(opcion.diferencia.tarifa),
      taxDifference: aTextoDecimal(opcion.diferencia.impuestos),
      changeFee: aTextoDecimal(opcion.diferencia.cargo),
      totalToPay: aTextoDecimal(opcion.diferencia.aPagar),
    },
  };
}
