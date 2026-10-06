import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDefined,
  Matches,
  ValidateNested,
  ValidationOptions,
  registerDecorator,
} from 'class-validator';
import { fechaIsoAUtc, REGEX_IATA_AEROPUERTO } from '../../../../../common/pipes/formatos';
import { PasajerosDto } from '../../../compartido/dto/pasajeros.dto';

/** Máximo de tramos de una búsqueda multidestino (SearchRequest.itineraries.maxItems). */
export const MAXIMO_TRAMOS = 6;

const IATA = { message: '$property must be a 3-letter uppercase IATA airport code' };

/** `YYYY-MM-DD` que existe en el calendario (rechaza 2026-02-30). */
function FechaIso(opciones?: ValidationOptions): PropertyDecorator {
  return (objeto, propiedad) =>
    registerDecorator({
      name: 'fechaIso',
      target: objeto.constructor,
      propertyName: propiedad as string,
      options: opciones,
      validator: {
        validate: (valor: unknown) => fechaIsoAUtc(valor) !== undefined,
        defaultMessage: ({ property }) => `${property} must be a valid date (YYYY-MM-DD)`,
      },
    });
}

/** Un tramo de SearchRequest.itineraries. */
export class TramoSolicitadoDto {
  @ApiProperty({ example: 'UIO', pattern: '^[A-Z]{3}$' })
  @Matches(REGEX_IATA_AEROPUERTO, IATA)
  origin: string;

  @ApiProperty({ example: 'GYE', pattern: '^[A-Z]{3}$' })
  @Matches(REGEX_IATA_AEROPUERTO, IATA)
  destination: string;

  @ApiProperty({
    example: '2026-10-20',
    format: 'date',
    description: 'Fecha local de salida en el aeropuerto de origen',
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
    example: [
      { origin: 'UIO', destination: 'GYE', departureDate: '2026-10-20' },
      { origin: 'GYE', destination: 'UIO', departureDate: '2026-10-25' },
    ],
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
