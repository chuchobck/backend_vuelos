import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDefined,
  Matches,
  ValidateNested,
} from 'class-validator';
import { REGEX_IATA_AEROPUERTO } from '../../../../../common/pipes/formatos';
import { FechaIso } from '../../../compartido/dto/validadores';
import { PasajerosDto } from '../../../compartido/dto/pasajeros.dto';
import { fechaDeEjemplo } from '../../../compartido/dto/ejemplos';

/** Máximo de tramos de una búsqueda multidestino (SearchRequest.itineraries.maxItems). */
export const MAXIMO_TRAMOS = 6;

const IATA = { message: '$property must be a 3-letter uppercase IATA airport code' };

/** Un tramo de SearchRequest.itineraries. */
export class TramoSolicitadoDto {
  @ApiProperty({ example: 'UIO', pattern: '^[A-Z]{3}$' })
  @Matches(REGEX_IATA_AEROPUERTO, IATA)
  origin: string;

  @ApiProperty({ example: 'GYE', pattern: '^[A-Z]{3}$' })
  @Matches(REGEX_IATA_AEROPUERTO, IATA)
  destination: string;

  @ApiProperty({
    example: fechaDeEjemplo(14),
    format: 'date',
    description: 'Fecha local de salida en el aeropuerto de origen (la semilla cubre 90 días)',
  })
  @FechaIso()
  departureDate: string;
}

/**
 * components.schemas.SearchRequest. Un tramo es solo ida; dos con los aeropuertos invertidos,
 * ida y vuelta; hasta 6, multidestino.
 */
export class SolicitudBusquedaDto {
  @ApiProperty({
    type: [TramoSolicitadoDto],
    minItems: 1,
    maxItems: MAXIMO_TRAMOS,
    // Solo ida: la guía de Swagger sigue con un hold de un itinerario. Ida y vuelta es otro tramo
    example: [{ origin: 'UIO', destination: 'GYE', departureDate: fechaDeEjemplo(14) }],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAXIMO_TRAMOS)
  @ValidateNested({ each: true })
  @Type(() => TramoSolicitadoDto)
  itineraries: TramoSolicitadoDto[];

  @ApiProperty({ type: PasajerosDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => PasajerosDto)
  passengers: PasajerosDto;
}
