import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDefined,
  IsIn,
  IsUUID,
  Matches,
  ValidateNested,
} from 'class-validator';
import { PasajerosDto } from '../../../compartido/dto/pasajeros.dto';
import { CABINA, CabinaContrato } from '../../../compartido/enums';
import { MAXIMO_TRAMOS } from '../../busqueda/dto/solicitud-busqueda.dto';

/** fareBrand: el código de la familia tarifaria (ck_familia_tarifa_codigo). */
const REGEX_FAMILIA = /^[A-Z0-9_]{2,20}$/;

/**
 * Un elemento de HoldRequest.itinerarySelections: la opción de precio elegida para un
 * itinerario de la oferta (una de sus pricingOptions). El contrato no fija formato a los ids;
 * los de esta API son uuid y otro texto no puede ser de una oferta: 400.
 */
export class SeleccionItinerarioDto {
  @ApiProperty({ format: 'uuid', description: 'itineraryId de la oferta (POST /search)' })
  @IsUUID('all', { message: '$property must be a UUID' })
  itineraryId: string;

  @ApiProperty({ enum: CABINA.valores, example: 'ECONOMY' })
  @IsIn(CABINA.valores, { message: `$property must be one of: ${CABINA.valores.join(', ')}` })
  cabinClass: CabinaContrato;

  @ApiProperty({ example: 'CLASSIC', pattern: REGEX_FAMILIA.source })
  @Matches(REGEX_FAMILIA, { message: '$property must be 2 to 20 uppercase letters, digits or _' })
  fareBrand: string;
}

/**
 * components.schemas.HoldRequest. Una selección por cada itinerario de la oferta, y los mismos
 * pasajeros de la búsqueda (con las mismas reglas: a lo sumo 9 con asiento, no más infantes
 * que adultos).
 */
export class SolicitudRetencionDto {
  @ApiProperty({ format: 'uuid', description: 'offerId de POST /search' })
  @IsUUID('all', { message: '$property must be a UUID' })
  offerId: string;

  @ApiProperty({
    type: [SeleccionItinerarioDto],
    minItems: 1,
    maxItems: MAXIMO_TRAMOS,
    description: 'Exactamente una por cada itinerario de la oferta',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAXIMO_TRAMOS)
  @ValidateNested({ each: true })
  @Type(() => SeleccionItinerarioDto)
  itinerarySelections: SeleccionItinerarioDto[];

  @ApiProperty({ type: PasajerosDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => PasajerosDto)
  passengersBreakdown: PasajerosDto;
}
