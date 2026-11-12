import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import {
  CABINA,
  CabinaContrato,
  ESTADO_VUELO,
  EstadoVueloContrato,
} from '../../../compartido/enums';

/** Los estados de un asiento vendido: los de SeatStatus del contrato v2, sin AVAILABLE ni HELD. */
export const ESTADOS_MANIFIESTO = ['BOOKED', 'TICKETED', 'CHECKED_IN', 'BOARDED'] as const;

/** POST /admin/departures/{departureId}/boarding/scan. */
export class EscanearPaseDto {
  @ApiProperty({
    example: 'BP1|K7M2QX|0451331201527|LA1400|20261020|UIOGYE|10A|001|9f2c41b7a0d3',
    maxLength: 120,
    description: 'El texto que leyó el lector, tal cual: el `barcode` de un pase de abordar',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  barcode: string;
}

/** El pasajero que el agente compara con el documento. Solo en el 200 del escaneo. */
export class PasajeroAbordadoDto {
  @ApiProperty({ example: 'ADU1' })
  passengerId: string;

  @ApiProperty({ example: 'Ana María' })
  firstName: string;

  @ApiProperty({ example: "D'Alessio Pérez" })
  lastName: string;
}

export class AbordajeDto {
  @ApiProperty({ enum: ['BOARDED'], example: 'BOARDED' })
  result: 'BOARDED';

  @ApiProperty({ format: 'uuid', description: 'La salida (segmentId) que la puerta embarca' })
  departureId: string;

  @ApiProperty({ example: 'LA1400' })
  flightNumber: string;

  @ApiProperty({ example: '10A' })
  seat: string;

  @ApiProperty({ example: '3', nullable: true })
  boardingGroup: string | null;

  @ApiProperty({ example: '010', nullable: true })
  boardingPosition: string | null;

  @ApiProperty({ format: 'date-time', description: 'UTC, la hora del servidor' })
  boardedAt: string;

  @ApiProperty({
    type: PasajeroAbordadoDto,
    description:
      'Nombre del pasajero, para compararlo con su documento. Excepción a la regla de datos ' +
      'personales, limitada a esta respuesta: sin documento, correo ni teléfono',
  })
  passenger: PasajeroAbordadoDto;

  @ApiProperty({
    type: [PasajeroAbordadoDto],
    description: 'Los infantes que viajan en brazos de ese pasajero y abordaron con su pase',
  })
  infants: PasajeroAbordadoDto[];
}

export class ConteoInfantesDto {
  @ApiProperty({ example: 1 })
  sold: number;

  @ApiProperty({ example: 1 })
  checkedIn: number;

  @ApiProperty({ example: 0 })
  boarded: number;
}

export class ConteoManifiestoDto {
  @ApiProperty({ example: 120, description: 'Asientos asignados y sin liberar' })
  sold: number;

  @ApiProperty({ example: 98, description: 'Con check-in (incluye los que ya abordaron)' })
  checkedIn: number;

  @ApiProperty({ example: 40 })
  boarded: number;

  @ApiProperty({ type: ConteoInfantesDto, description: 'Infantes en brazos: no ocupan asiento' })
  infants: ConteoInfantesDto;
}

export class AsientoManifiestoDto {
  @ApiProperty({ example: '10A' })
  seat: string;

  @ApiProperty({ enum: CABINA.valores, example: 'ECONOMY' })
  cabinClass: CabinaContrato;

  @ApiProperty({ example: 'K7M2QX', description: 'Para buscar la reserva en /admin/bookings' })
  pnr: string;

  @ApiProperty({ example: 'ADU1' })
  passengerId: string;

  @ApiProperty({ enum: ESTADOS_MANIFIESTO, example: 'CHECKED_IN' })
  status: (typeof ESTADOS_MANIFIESTO)[number];

  @ApiProperty({ example: '3', nullable: true, description: 'null sin check-in' })
  boardingGroup: string | null;

  @ApiProperty({ format: 'date-time', nullable: true, description: 'UTC; null si no abordó' })
  boardedAt: string | null;
}

export class ManifiestoDto {
  @ApiProperty({ format: 'uuid' })
  departureId: string;

  @ApiProperty({ example: 'LA1400' })
  flightNumber: string;

  @ApiProperty({ example: '2026-10-20', format: 'date', description: 'Fecha local de salida' })
  date: string;

  @ApiProperty({ example: 'UIO' })
  origin: string;

  @ApiProperty({ example: 'GYE' })
  destination: string;

  @ApiProperty({ enum: ESTADO_VUELO.valores, example: 'BOARDING' })
  status: EstadoVueloContrato;

  @ApiProperty({ example: 'A3', nullable: true })
  gate: string | null;

  @ApiProperty({ type: ConteoManifiestoDto })
  counts: ConteoManifiestoDto;

  @ApiProperty({
    type: [AsientoManifiestoDto],
    description: 'Por fila y letra. Sin nombre, documento ni correo',
  })
  seats: AsientoManifiestoDto[];
}
