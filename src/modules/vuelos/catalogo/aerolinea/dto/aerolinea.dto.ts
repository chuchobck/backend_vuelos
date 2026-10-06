import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, Matches, MaxLength, ValidateIf } from 'class-validator';
import { REGEX_IATA_AEROLINEA, REGEX_PREFIJO_BOLETO } from '../../../../../common/pipes/formatos';
import { TextoLimpio } from '../../../../../common/sanitizacion/texto-limpio.decorator';
import { ConsultaCatalogoDto } from '../../base/paginacion';

export class AerolineaRespuestaDto {
  @ApiProperty({ example: 'AV', description: 'Código IATA; es el id en la URL' })
  code: string;

  @ApiProperty({ example: 'Avianca' })
  name: string;

  @ApiProperty({
    example: '134',
    nullable: true,
    description: 'Prefijo de 3 dígitos de sus boletos electrónicos',
  })
  ticketPrefix: string | null;

  @ApiProperty({ example: true })
  active: boolean;
}

export class CrearAerolineaDto {
  @ApiProperty({ example: 'EQ' })
  @Matches(REGEX_IATA_AEROLINEA, { message: 'code must be a 2-character uppercase IATA code' })
  code: string;

  @ApiProperty({ example: 'TAME', maxLength: 100 })
  @TextoLimpio()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({ example: '269' })
  @IsOptional()
  @Matches(REGEX_PREFIJO_BOLETO, { message: 'ticketPrefix must be 3 digits' })
  ticketPrefix?: string;
}

/** El código IATA es la identidad de la aerolínea: no se cambia. */
export class ActualizarAerolineaDto {
  @ApiPropertyOptional({ example: 'TAME Línea Aérea del Ecuador', maxLength: 100 })
  @TextoLimpio()
  @IsOptional()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ example: '269', nullable: true, description: 'null lo quita' })
  @IsOptional()
  @ValidateIf((_dto, valor) => valor !== null)
  @Matches(REGEX_PREFIJO_BOLETO, { message: 'ticketPrefix must be 3 digits' })
  ticketPrefix?: string | null;
}

export class ConsultaAerolineaDto extends ConsultaCatalogoDto {}
