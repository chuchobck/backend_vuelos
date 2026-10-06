import { posicion_asiento } from '../../../../generated/prisma/client';
import { CABINA } from '../../compartido/enums';
import {
  Caracteristica,
  CabinaMapaOfertaDto,
  MapaAsientosOfertaDto,
} from './dto/mapa-asientos-oferta.dto';
import { MapaDeSegmento } from './oferta.service';

/** Como dice el COMMENT de posicion_asiento: CENTRO no genera característica. */
const POR_POSICION: Record<posicion_asiento, Caracteristica | undefined> = {
  VENTANA: 'WINDOW',
  PASILLO: 'AISLE',
  CENTRO: undefined,
};

/** Fila de la base → SeatMapResponse. Sin ids internos: el asiento es su número (12A). */
export function aMapaAsientosOferta(mapa: MapaDeSegmento): MapaAsientosOfertaDto {
  const cabinas: CabinaMapaOfertaDto[] = [];
  for (const fila of mapa.filas) {
    const cabinClass = CABINA.aContrato(fila.clase_cabina);
    let cabina = cabinas[cabinas.length - 1];
    if (cabina?.cabinClass !== cabinClass) {
      cabina = { cabinClass, rows: [] };
      cabinas.push(cabina);
    }
    const seVende = mapa.cabinasVendidas.has(fila.clase_cabina);
    cabina.rows.push({
      rowNumber: fila.numero_fila,
      seats: fila.asiento.map((asiento) => ({
        seatNumber: `${fila.numero_fila}${asiento.letra}`,
        isAvailable: seVende && !mapa.ocupados.has(asiento.id),
        characteristics: [
          POR_POSICION[asiento.posicion],
          fila.espacio_extra ? 'EXTRA_LEGROOM' : undefined,
          fila.salida_emergencia ? 'EMERGENCY_EXIT' : undefined,
        ].filter((c): c is Caracteristica => c !== undefined),
      })),
    });
  }
  return { segmentId: mapa.salidaId, cabins: cabinas };
}
