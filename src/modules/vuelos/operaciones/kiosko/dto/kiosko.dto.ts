import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import {
  ESTADO_RESERVA,
  ESTADO_VUELO,
  EstadoReservaContrato,
  EstadoVueloContrato,
  TIPO_PASAJERO,
  TipoPasajeroContrato,
} from '../../../compartido/enums';

const ESTADOS_PASAJERO = ['CHECKED_IN', 'NOT_CHECKED_IN', 'FAILED'] as const;
export const VENTANAS = ['OPEN', 'NOT_YET_OPEN', 'CLOSED'] as const;

/** POST /kiosk/lookup. Los mensajes de validación nombran el campo, nunca el valor. */
export class BuscarEnKioskoDto {
  @ApiProperty({ example: 'K7M2QX', description: 'El localizador de 6 letras o dígitos' })
  @IsString()
  @Matches(/^[A-Za-z0-9]{6}$/, { message: '$property must be 6 letters or digits' })
  pnr: string;

  @ApiProperty({
    example: 'Pérez',
    maxLength: 100,
    description:
      'El apellido completo de cualquier pasajero de la reserva. No importan mayúsculas, tildes, ' +
      'espacios ni guiones',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName: string;
}

export class PasajeroKioskoDto {
  @ApiProperty({ example: 'ADU1' })
  passengerId: string;

  @ApiProperty({ enum: TIPO_PASAJERO.valores, example: 'ADULT' })
  passengerType: TipoPasajeroContrato;

  @ApiProperty({ example: 'Ana María' })
  firstName: string;

  @ApiProperty({ example: 'Pérez' })
  lastName: string;
}

export class VentanaKioskoDto {
  @ApiProperty({ enum: VENTANAS, example: 'OPEN' })
  window: (typeof VENTANAS)[number];

  @ApiProperty({ format: 'date-time', description: 'UTC' })
  opensAt: string;

  @ApiProperty({ format: 'date-time', description: 'UTC' })
  closesAt: string;
}

export class PasajeroEnVueloKioskoDto {
  @ApiProperty({ example: 'ADU1' })
  passengerId: string;

  @ApiProperty({ example: '10A', nullable: true, description: 'null para un infante' })
  seat: string | null;

  @ApiProperty({
    enum: ESTADOS_PASAJERO,
    example: 'NOT_CHECKED_IN',
    description: 'El mismo estado por segmento de CheckInResponse',
  })
  checkInStatus: (typeof ESTADOS_PASAJERO)[number];
}

export class VueloKioskoDto {
  @ApiProperty({ format: 'uuid' })
  segmentId: string;

  @ApiProperty({ example: 'LA1400' })
  flightNumber: string;

  @ApiProperty({ example: 'UIO' })
  origin: string;

  @ApiProperty({ example: 'GYE' })
  destination: string;

  @ApiProperty({ format: 'date-time', description: 'UTC' })
  departureAt: string;

  @ApiProperty({ format: 'date-time', description: 'UTC' })
  arrivalAt: string;

  @ApiProperty({ example: null, nullable: true })
  departureTerminal: string | null;

  @ApiProperty({ enum: ESTADO_VUELO.valores, example: 'SCHEDULED' })
  status: EstadoVueloContrato;

  @ApiProperty({ type: VentanaKioskoDto })
  checkIn: VentanaKioskoDto;

  @ApiProperty({ type: [PasajeroEnVueloKioskoDto] })
  passengers: PasajeroEnVueloKioskoDto[];
}

export class ReservaKioskoDto {
  @ApiProperty({ format: 'uuid', description: 'Va en la ruta del check-in y de los pases' })
  bookingId: string;

  @ApiProperty({ enum: ESTADO_RESERVA.valores, example: 'CONFIRMED' })
  status: EstadoReservaContrato;

  @ApiProperty({ type: [PasajeroKioskoDto] })
  passengers: PasajeroKioskoDto[];

  @ApiProperty({ type: [VueloKioskoDto], description: 'En orden de viaje' })
  flights: VueloKioskoDto[];
}

export class SesionKioskoDto {
  @ApiProperty({
    example: 'ksk1.eyJyIjoi….3q2-7w',
    description:
      'La sesión del kiosko: se manda en `Authorization: Kiosk <kioskToken>` al check-in y a los ' +
      'pases de ESTA reserva. No sirve para otra ni como token de acceso',
  })
  kioskToken: string;

  @ApiProperty({ format: 'date-time', description: 'UTC; 10 minutos después de la búsqueda' })
  expiresAt: string;

  @ApiProperty({
    type: ReservaKioskoDto,
    description: 'Solo lo que el kiosko muestra: sin documento, correo, teléfono, precio ni PNR',
  })
  booking: ReservaKioskoDto;
}
