import { clase_cabina } from '../../../../generated/prisma/client';
import { CABINA, POSICION_ASIENTO } from '../../compartido/enums';
import {
  CabinaMapaDto,
  MapaAsientosRespuestaDto,
  MapaAsientosResumenDto,
} from './dto/mapa-asientos.dto';
import { FilaMapaAsientos } from './mapa-asientos.repository';

/** Asientos físicos por cabina, en el orden de las filas. */
export function asientosPorCabina(mapa: FilaMapaAsientos): Map<clase_cabina, number> {
  const porCabina = new Map<clase_cabina, number>();
  for (const fila of mapa.mapa_asientos_detalle) {
    porCabina.set(fila.clase_cabina, (porCabina.get(fila.clase_cabina) ?? 0) + fila.asiento.length);
  }
  return porCabina;
}

export function aMapaAsientosResumen(fila: FilaMapaAsientos): MapaAsientosResumenDto {
  const cabinas: CabinaMapaDto[] = [...asientosPorCabina(fila)].map(([cabina, asientos]) => ({
    cabinClass: CABINA.aContrato(cabina),
    seats: asientos,
  }));
  return {
    id: fila.id_publico,
    airline: fila.aerolinea.codigo_iata,
    aircraftModel: fila.modelo_aeronave.codigo_iata,
    name: fila.nombre,
    cabins: cabinas,
    active: fila.activo,
  };
}

export function aMapaAsientosRespuesta(fila: FilaMapaAsientos): MapaAsientosRespuestaDto {
  return {
    ...aMapaAsientosResumen(fila),
    rows: fila.mapa_asientos_detalle.map((f) => ({
      number: f.numero_fila,
      cabinClass: CABINA.aContrato(f.clase_cabina),
      extraLegroom: f.espacio_extra,
      emergencyExit: f.salida_emergencia,
      seats: f.asiento.map((a) => ({
        letter: a.letra,
        position: POSICION_ASIENTO.aContrato(a.posicion),
      })),
    })),
  };
}
