import { ApiProperty } from '@nestjs/swagger';
import { CABINA, CabinaContrato } from '../../../compartido/enums';

/** Características de SeatMapResponse (enum cerrado del contrato). */
export const CARACTERISTICAS = ['WINDOW', 'AISLE', 'EXTRA_LEGROOM', 'EMERGENCY_EXIT'] as const;
export type Caracteristica = (typeof CARACTERISTICAS)[number];

export class AsientoMapaDto {
  @ApiProperty({ example: '12A', description: 'Fila y letra' })
  seatNumber: string;

  @ApiProperty({
    example: true,
    description: 'false si ya está asignado en una reserva o su cabina no se vende en esta salida',
  })
  isAvailable: boolean;

  @ApiProperty({ enum: CARACTERISTICAS, isArray: true, example: ['WINDOW'] })
  characteristics: Caracteristica[];
}

export class FilaMapaDto {
  @ApiProperty({ example: 12 })
  rowNumber: number;

  @ApiProperty({ type: [AsientoMapaDto] })
  seats: AsientoMapaDto[];
}

export class CabinaMapaOfertaDto {
  @ApiProperty({ enum: CABINA.valores, example: 'ECONOMY' })
  cabinClass: CabinaContrato;

  @ApiProperty({ type: [FilaMapaDto] })
  rows: FilaMapaDto[];
}

/** components.schemas.SeatMapResponse: mapa básico, sin precios. */
export class MapaAsientosOfertaDto {
  @ApiProperty({ format: 'uuid' })
  segmentId: string;

  @ApiProperty({ type: [CabinaMapaOfertaDto], description: 'En el orden de las filas' })
  cabins: CabinaMapaOfertaDto[];
}
