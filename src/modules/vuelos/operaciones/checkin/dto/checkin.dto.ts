import { ApiProperty } from '@nestjs/swagger';

/** Los DTO copian components.schemas del contrato, con sus mismos nombres. */

const ESTADOS_PASAJERO = ['CHECKED_IN', 'NOT_CHECKED_IN', 'FAILED'] as const;
const ESTADOS_GENERALES = [
  'NOT_ELIGIBLE',
  'AVAILABLE',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
] as const;

/** Un elemento de CheckInResponse.checkedInPassengers[].segments. */
export class TramoCheckinDto {
  @ApiProperty({ format: 'uuid', description: 'segmentId del vuelo' })
  segmentId: string;

  @ApiProperty({
    example: '10A',
    nullable: true,
    description: 'Asiento del pasajero en ese vuelo; null para un infante (viaja en brazos)',
  })
  seat: string | null;

  @ApiProperty({ enum: ESTADOS_PASAJERO, example: 'CHECKED_IN' })
  status: (typeof ESTADOS_PASAJERO)[number];
}

/** Un elemento de CheckInResponse.checkedInPassengers. */
export class PasajeroCheckinDto {
  @ApiProperty({ example: 'PAX1' })
  passengerId: string;

  @ApiProperty({
    enum: ESTADOS_PASAJERO,
    example: 'CHECKED_IN',
    description: 'CHECKED_IN si lo está en todos los segmentos; FAILED si alguno ya no se puede',
  })
  status: (typeof ESTADOS_PASAJERO)[number];

  @ApiProperty({ type: [TramoCheckinDto] })
  segments: TramoCheckinDto[];
}

/** components.schemas.CheckInResponse. */
export class CheckInRespuestaDto {
  @ApiProperty({ format: 'uuid' })
  bookingId: string;

  @ApiProperty({
    enum: ESTADOS_GENERALES,
    example: 'COMPLETED',
    description:
      'COMPLETED si todos los pasajeros lo están en todos los segmentos; si no, IN_PROGRESS',
  })
  status: (typeof ESTADOS_GENERALES)[number];

  @ApiProperty({ type: [PasajeroCheckinDto] })
  checkedInPassengers: PasajeroCheckinDto[];
}
