import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsUUID,
  Matches,
  ValidateNested,
} from 'class-validator';
import {
  CABINA,
  CabinaContrato,
  TIPO_PASAJERO,
  TipoPasajeroContrato,
} from '../../../compartido/enums';
import { ConsultaCatalogoDto } from '../../base/paginacion';

/**
 * Dinero en texto, como MoneyAmount del contrato: hasta 10 enteros y 2 decimales
 * (numeric(12,2)). Nunca como number: 0.1 + 0.2 no da 0.3 en JavaScript.
 */
const REGEX_DINERO = /^\d{1,10}(\.\d{1,2})?$/;
const DINERO = { message: '$property must be an amount in text, such as "35.00"' };

export class PrecioPasajeroDto {
  @ApiProperty({ enum: TIPO_PASAJERO.valores, example: 'ADULT' })
  @IsIn(TIPO_PASAJERO.valores)
  passengerType: TipoPasajeroContrato;

  @ApiProperty({ example: '89.00' })
  @Matches(REGEX_DINERO, DINERO)
  baseFare: string;

  @ApiProperty({ example: '12.46', description: 'IVA y tasas aeroportuarias' })
  @Matches(REGEX_DINERO, DINERO)
  taxes: string;
}

export class PrecioPasajeroRespuestaDto extends PrecioPasajeroDto {
  @ApiProperty({ example: '101.46', description: 'baseFare + taxes (no se guarda)' })
  total: string;
}

export class TarifaRespuestaDto {
  @ApiProperty({ format: 'uuid', description: 'Es el id en la URL' })
  id: string;

  @ApiProperty({ format: 'uuid', description: 'Salida (/admin/departures/{id})' })
  departureId: string;

  @ApiProperty({ example: 'AV1500' })
  flightNumber: string;

  @ApiProperty({ format: 'uuid', description: 'Familia (/admin/fare-families/{id})' })
  fareFamilyId: string;

  @ApiProperty({ example: 'CLASSIC', description: 'fareBrand del contrato' })
  fareBrand: string;

  @ApiProperty({ enum: CABINA.valores, example: 'ECONOMY' })
  cabinClass: CabinaContrato;

  @ApiProperty({ example: 'USD' })
  currency: string;

  @ApiProperty({ example: '35.00', description: 'extraCheckedBaggagePrice del contrato' })
  extraBagPrice: string;

  @ApiProperty({ example: '0.00', description: 'changeFee del contrato' })
  changeFee: string;

  @ApiProperty({ type: [PrecioPasajeroRespuestaDto], description: 'pricePerPassengerType' })
  prices: PrecioPasajeroRespuestaDto[];

  @ApiProperty({ example: true, description: 'false: ya no se vende' })
  active: boolean;
}

/** Al menos el precio de adulto y ningún tipo de pasajero repetido. */
class PreciosDto {
  @ApiProperty({ type: [PrecioPasajeroDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => PrecioPasajeroDto)
  prices: PrecioPasajeroDto[];
}

/** Salida, familia y moneda son la identidad de la tarifa: se fijan al crearla. */
export class CrearTarifaDto extends PreciosDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  departureId: string;

  @ApiProperty({ format: 'uuid', description: 'De la aerolínea que comercializa el vuelo' })
  @IsUUID()
  fareFamilyId: string;

  @ApiProperty({ example: 'USD' })
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter ISO 4217 code' })
  currency: string;

  @ApiProperty({ example: '35.00' })
  @Matches(REGEX_DINERO, DINERO)
  extraBagPrice: string;

  @ApiPropertyOptional({ example: '0.00', default: '0.00' })
  @IsOptional()
  @Matches(REGEX_DINERO, DINERO)
  changeFee?: string;
}

/**
 * Montos. `prices` cambia los tipos que trae y agrega los que falten; un tipo de pasajero
 * que ya tiene precio no se quita (habría que borrar la fila).
 */
export class ActualizarTarifaDto {
  @ApiPropertyOptional({ example: '40.00' })
  @IsOptional()
  @Matches(REGEX_DINERO, DINERO)
  extraBagPrice?: string;

  @ApiPropertyOptional({ example: '25.00' })
  @IsOptional()
  @Matches(REGEX_DINERO, DINERO)
  changeFee?: string;

  @ApiPropertyOptional({ type: [PrecioPasajeroDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => PrecioPasajeroDto)
  prices?: PrecioPasajeroDto[];
}

export class ConsultaTarifaDto extends ConsultaCatalogoDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Solo las de esta salida' })
  @IsOptional()
  @IsUUID()
  departureId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Solo las de esta familia' })
  @IsOptional()
  @IsUUID()
  fareFamilyId?: string;
}
