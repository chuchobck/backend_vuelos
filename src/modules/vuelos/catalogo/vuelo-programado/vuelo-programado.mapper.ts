import { CABINA, ESTADO_VUELO } from '../../compartido/enums';
import { aFecha, aInstante } from '../../compartido/formatos-salida';
import { VueloProgramadoRespuestaDto } from './dto/vuelo-programado.dto';
import { FilaVueloProgramado, numeroVueloDeSalida } from './vuelo-programado.repository';

export function aVueloProgramadoRespuesta(fila: FilaVueloProgramado): VueloProgramadoRespuestaDto {
  return {
    id: fila.id,
    flightNumber: numeroVueloDeSalida(fila),
    origin: fila.vuelo.aeropuerto_vuelo_aeropuerto_origen_idToaeropuerto.codigo_iata,
    destination: fila.vuelo.aeropuerto_vuelo_aeropuerto_destino_idToaeropuerto.codigo_iata,
    departureDate: aFecha(fila.fecha_salida),
    scheduledDeparture: aInstante(fila.salida_programada),
    scheduledArrival: aInstante(fila.llegada_programada),
    estimatedDeparture: aInstante(fila.salida_estimada),
    estimatedArrival: aInstante(fila.llegada_estimada),
    actualDeparture: aInstante(fila.salida_real),
    actualArrival: aInstante(fila.llegada_real),
    departureTerminal: fila.terminal_salida,
    arrivalTerminal: fila.terminal_llegada,
    status: ESTADO_VUELO.aContrato(fila.estado),
    seatMapId: fila.mapa_asientos_cabecera.id_publico,
    aircraftModel: fila.mapa_asientos_cabecera.modelo_aeronave.codigo_iata,
    cabins: fila.inventario_cabina.map((cupo) => ({
      cabinClass: CABINA.aContrato(cupo.clase_cabina),
      totalSeats: cupo.cupos_totales,
      availableSeats: cupo.cupos_disponibles,
    })),
    active: fila.estado !== 'CANCELADO',
  };
}
