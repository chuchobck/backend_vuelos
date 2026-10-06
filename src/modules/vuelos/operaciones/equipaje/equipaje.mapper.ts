import { aTextoDecimal } from '../../compartido/formatos-salida';
import { EquipajeAgregadoDto, OpcionEquipajeDto } from './dto/equipaje.dto';
import { EquipajeAgregado, OpcionEquipaje } from './equipaje.modelo';

export function aOpcionEquipaje(opcion: OpcionEquipaje): OpcionEquipajeDto {
  return {
    passengerId: opcion.codigoPasajero,
    itineraryId: opcion.itinerarioId,
    price: { currency: opcion.moneda, total: aTextoDecimal(opcion.precio) },
    maxAllowed: opcion.maximo,
    alreadyPurchased: opcion.comprado,
  };
}

export function aEquipajeAgregado(agregado: EquipajeAgregado): EquipajeAgregadoDto {
  return {
    passengerId: agregado.codigoPasajero,
    itineraryId: agregado.itinerarioId,
    totalBaggage: agregado.total,
  };
}
