import { ApiProperty } from '@nestjs/swagger';
import { ESTADO_VUELO, EstadoVueloContrato } from '../../../compartido/enums';

/** Los DTO copian components.schemas del contrato, con sus mismos nombres. */

/** FlightStatus.departure y FlightStatus.arrival. */
export class ExtremoEstadoDto {
  @ApiProperty({ example: 'UIO', pattern: '^[A-Z]{3}$' })
  iataCode: string;

  @ApiProperty({ example: null, nullable: true })
  terminal: string | null;

  @ApiProperty({ example: '2026-10-20T11:00:00.000Z', format: 'date-time', description: 'UTC' })
  scheduledAt: string;

  @ApiProperty({ example: null, format: 'date-time', nullable: true, description: 'UTC' })
  estimatedAt: string | null;

  @ApiProperty({ example: null, format: 'date-time', nullable: true, description: 'UTC' })
  actualAt: string | null;
}

/** components.schemas.FlightStatus. */
export class EstadoVueloDto {
  @ApiProperty({ example: 'LA1400' })
  flightNumber: string;

  @ApiProperty({ example: '2026-10-20', format: 'date', description: 'Fecha local de salida' })
  date: string;

  @ApiProperty({ example: 'LA' })
  marketingCarrier: string;

  @ApiProperty({ example: 'LA' })
  operatingCarrier: string;

  @ApiProperty({ type: ExtremoEstadoDto })
  departure: ExtremoEstadoDto;

  @ApiProperty({ type: ExtremoEstadoDto })
  arrival: ExtremoEstadoDto;

  @ApiProperty({ example: '320', nullable: true })
  aircraft: string | null;

  @ApiProperty({ enum: ESTADO_VUELO.valores, example: 'SCHEDULED' })
  status: EstadoVueloContrato;
}
