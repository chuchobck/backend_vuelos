import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsInt,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { MontoDto } from '../../../compartido/dto/monto.dto';
import { REGEX_CODIGO_PASAJERO, ReferenciaPagoDto } from '../../reserva/dto/solicitud-reserva.dto';

/** Los DTO copian components.schemas del contrato, con sus mismos nombres. */

/** Máximo de maletas de una compra (ck_reserva_detalle_equipaje_cantidad). */
export const MAXIMO_MALETAS_POR_COMPRA = 10;

/** Un elemento de components.schemas.BaggageOptionsResponse. */
export class OpcionEquipajeDto {
  @ApiProperty({ example: 'PAX1' })
  passengerId: string;

  @ApiProperty({ format: 'uuid', description: 'itineraryId de la reserva' })
  itineraryId: string;

  @ApiProperty({
    type: MontoDto,
    example: { currency: 'USD', total: '15.00' },
    description: 'Precio de una maleta adicional en ese itinerario (todos sus vuelos)',
  })
  price: MontoDto;

  @ApiProperty({ example: 2, description: 'Maletas adicionales que admite la familia tarifaria' })
  maxAllowed: number;

  @ApiProperty({ example: 0, description: 'Maletas ya compradas (aprobadas o con pago pendiente)' })
  alreadyPurchased: number;
}

/** components.schemas.AddBaggageRequest. */
export class SolicitudEquipajeDto {
  @ApiProperty({ example: 'PAX1', description: 'passengerId de un pasajero de la reserva' })
  @IsString()
  @Matches(REGEX_CODIGO_PASAJERO, {
    message: '$property must be 1 to 20 letters, digits, _ or -',
  })
  passengerId: string;

  @ApiProperty({ format: 'uuid', description: 'itineraryId de un itinerario de la reserva' })
  @IsUUID('all', { message: '$property must be a UUID' })
  itineraryId: string;

  @ApiProperty({ example: 1, minimum: 1, maximum: MAXIMO_MALETAS_POR_COMPRA })
  @IsInt()
  @Min(1)
  @Max(MAXIMO_MALETAS_POR_COMPRA)
  quantity: number;

  @ApiProperty({ type: ReferenciaPagoDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => ReferenciaPagoDto)
  payment: ReferenciaPagoDto;
}

/** components.schemas.BaggageAddedResponse (200; también el cuerpo del 202). */
export class EquipajeAgregadoDto {
  @ApiProperty({ example: 'PAX1' })
  passengerId: string;

  @ApiProperty({ format: 'uuid' })
  itineraryId: string;

  @ApiProperty({
    example: 1,
    description: 'Maletas adicionales del pasajero en ese itinerario, contando esta compra',
  })
  totalBaggage: number;
}
