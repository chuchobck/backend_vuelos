import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  ValidateNested,
} from 'class-validator';
import { FechaIso } from '../../../compartido/dto/validadores';
import { SegmentoVueloDto } from '../../busqueda/dto/respuesta-busqueda.dto';
import { MAXIMO_TRAMOS } from '../../busqueda/dto/solicitud-busqueda.dto';
import { REGEX_NUMERO_ASIENTO, ReferenciaPagoDto } from '../../reserva/dto/solicitud-reserva.dto';

/** Los DTO copian components.schemas del contrato, con sus mismos nombres. */

/** Un elemento de DateChangeSearchRequest.changes. */
export class CambioPedidoDto {
  @ApiProperty({ format: 'uuid', description: 'itineraryId de un itinerario de la reserva' })
  @IsUUID('all', { message: '$property must be a UUID' })
  itineraryId: string;

  @ApiProperty({
    example: '2026-10-28',
    format: 'date',
    description: 'Nueva fecha local de salida en el origen del itinerario',
  })
  @FechaIso()
  newDepartureDate: string;
}

/** components.schemas.DateChangeSearchRequest. */
export class SolicitudBusquedaCambioDto {
  @ApiProperty({ type: [CambioPedidoDto], minItems: 1, maxItems: MAXIMO_TRAMOS })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAXIMO_TRAMOS)
  @ValidateNested({ each: true })
  @Type(() => CambioPedidoDto)
  changes: CambioPedidoDto[];
}

/** DateChangeSearchResponse[].priceDifference: montos en texto, para todos los pasajeros. */
export class DiferenciaPrecioDto {
  @ApiProperty({
    example: '12.40',
    description: 'Tarifa nueva menos la pagada; puede ser negativa',
  })
  fareDifference: string;

  @ApiProperty({
    example: '2.48',
    description: 'Impuestos nuevos menos los pagados; puede ser negativa',
  })
  taxDifference: string;

  @ApiProperty({ example: '12.32', description: 'Cargo por cambio de la tarifa original' })
  changeFee: string;

  @ApiProperty({
    example: '27.20',
    description:
      'Lo que se cobra: diferencias más cargo, nunca menos de 0 (lo que baja no se devuelve)',
  })
  totalToPay: string;
}

/** Un elemento de components.schemas.DateChangeSearchResponse. */
export class OpcionCambioDto {
  @ApiProperty({ format: 'uuid' })
  changeOfferId: string;

  @ApiProperty({ example: '2026-10-06T15:15:00.000Z', format: 'date-time' })
  expiresAt: string;

  @ApiProperty({
    type: [SegmentoVueloDto],
    description: 'Los vuelos nuevos de los itinerarios que cambian',
  })
  segments: SegmentoVueloDto[];

  @ApiProperty({ type: DiferenciaPrecioDto })
  priceDifference: DiferenciaPrecioDto;
}

/** Un elemento de DateChangeRequest.assignedSeats. */
export class AsientoCambioDto {
  @ApiProperty({ format: 'uuid', description: 'segmentId de un vuelo nuevo de la oferta' })
  @IsUUID('all', { message: '$property must be a UUID' })
  segmentId: string;

  @ApiProperty({ example: '12A', pattern: REGEX_NUMERO_ASIENTO.source })
  @IsString()
  @Matches(REGEX_NUMERO_ASIENTO, { message: '$property must be a row and a letter (12A)' })
  seatNumber: string;
}

/** components.schemas.DateChangeRequest. */
export class SolicitudCambioDto {
  @ApiProperty({ format: 'uuid', description: 'changeOfferId de POST .../date-change/search' })
  @IsUUID('all', { message: '$property must be a UUID' })
  changeOfferId: string;

  @ApiPropertyOptional({
    type: ReferenciaPagoDto,
    description: 'Obligatorio si totalToPay es mayor que 0',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ReferenciaPagoDto)
  payment?: ReferenciaPagoDto;

  @ApiPropertyOptional({
    type: [AsientoCambioDto],
    description:
      'Asientos en los vuelos nuevos. En cada vuelo se dan a los pasajeros con asiento en el ' +
      'orden de la reserva; los que no se eligen se asignan como al reservar',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAXIMO_TRAMOS * 2 * 9)
  @ValidateNested({ each: true })
  @Type(() => AsientoCambioDto)
  assignedSeats?: AsientoCambioDto[];
}
