import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { REGEX_IATA_AEROLINEA } from '../../../../../common/pipes/formatos';
import { TextoLimpio } from '../../../../../common/sanitizacion/texto-limpio.decorator';
import { CABINA, CabinaContrato } from '../../../compartido/enums';
import { ConsultaCatalogoDto } from '../../base/paginacion';

/** fareBrand del contrato, en mayúsculas (ck_familia_tarifa_codigo). */
const REGEX_CODIGO_FAMILIA = /^[A-Z0-9_]{2,20}$/;

/** Porcentaje de 0 a 100 con hasta 2 decimales, en texto (numeric(5,2)). */
const REGEX_PORCENTAJE = /^(100(\.0{1,2})?|\d{1,2}(\.\d{1,2})?)$/;

export class FamiliaTarifaRespuestaDto {
  @ApiProperty({ format: 'uuid', description: 'Es el id en la URL' })
  id: string;

  @ApiProperty({ example: 'AV', description: 'Aerolínea (IATA)' })
  airline: string;

  @ApiProperty({ enum: CABINA.valores, example: 'ECONOMY' })
  cabinClass: CabinaContrato;

  @ApiProperty({ example: 'CLASSIC', description: 'fareBrand del contrato' })
  code: string;

  @ApiProperty({ example: 'Classic' })
  name: string;

  @ApiProperty({ example: true, description: 'Admite cambio de fecha' })
  changeable: boolean;

  @ApiProperty({ example: '30.00', description: 'Porcentaje que se retiene al cancelar' })
  cancellationPenaltyPercent: string;

  @ApiProperty({ example: true, description: 'isRefundable del contrato: penalidad menor a 100' })
  refundable: boolean;

  @ApiProperty({ example: true })
  personalItemIncluded: boolean;

  @ApiProperty({ example: 1, minimum: 0, maximum: 3 })
  carryOnBagsIncluded: number;

  @ApiProperty({ example: 1, minimum: 0, maximum: 5 })
  checkedBagsIncluded: number;

  @ApiProperty({ example: 3, minimum: 0, maximum: 10, description: 'maxAllowed del contrato' })
  maxExtraBags: number;

  @ApiProperty({ example: true })
  active: boolean;
}

/** Reglas de equipaje y de cambio: lo que se puede modificar de una familia. */
class ReglasFamiliaDto {
  @ApiPropertyOptional({ example: 'Classic', maxLength: 100 })
  @TextoLimpio()
  @IsOptional()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  changeable?: boolean;

  @ApiPropertyOptional({ example: '30.00', description: 'De 0 a 100, en texto' })
  @IsOptional()
  @Matches(REGEX_PORCENTAJE, {
    message: 'cancellationPenaltyPercent must be a number from 0 to 100 with up to 2 decimals',
  })
  cancellationPenaltyPercent?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  personalItemIncluded?: boolean;

  @ApiPropertyOptional({ example: 1, minimum: 0, maximum: 3 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3)
  carryOnBagsIncluded?: number;

  @ApiPropertyOptional({ example: 1, minimum: 0, maximum: 5 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  checkedBagsIncluded?: number;

  @ApiPropertyOptional({ example: 3, minimum: 0, maximum: 10 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  maxExtraBags?: number;
}

/**
 * Aerolínea, cabina y código son la clave natural de la familia: se fijan al crearla. Sin
 * los demás campos valen lo mismo que en la base: no cambiable, 100 % de penalidad (no
 * reembolsable), artículo personal incluido, 0 maletas incluidas y hasta 3 adicionales.
 */
export class CrearFamiliaTarifaDto extends ReglasFamiliaDto {
  @ApiProperty({ example: 'AV' })
  @Matches(REGEX_IATA_AEROLINEA, { message: 'airline must be a 2-character uppercase IATA code' })
  airline: string;

  @ApiProperty({ enum: CABINA.valores, example: 'ECONOMY' })
  @IsIn(CABINA.valores)
  cabinClass: CabinaContrato;

  @ApiProperty({ example: 'PLUS' })
  @Matches(REGEX_CODIGO_FAMILIA, {
    message: 'code must be 2 to 20 uppercase letters, digits or underscores',
  })
  code: string;

  @ApiProperty({ example: 'Plus', maxLength: 100 })
  @TextoLimpio()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiProperty({ example: true })
  @IsBoolean()
  changeable: boolean;
}

export class ActualizarFamiliaTarifaDto extends ReglasFamiliaDto {}

export class ConsultaFamiliaTarifaDto extends ConsultaCatalogoDto {
  @ApiPropertyOptional({ example: 'AV' })
  @IsOptional()
  @Matches(REGEX_IATA_AEROLINEA, { message: 'airline must be a 2-character uppercase IATA code' })
  airline?: string;

  @ApiPropertyOptional({ enum: CABINA.valores })
  @IsOptional()
  @IsIn(CABINA.valores)
  cabinClass?: CabinaContrato;
}
