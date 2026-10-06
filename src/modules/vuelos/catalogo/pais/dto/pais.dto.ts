import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, Matches, MaxLength } from 'class-validator';
import { REGEX_PAIS_ISO2, REGEX_PAIS_ISO3 } from '../../../../../common/pipes/formatos';
import { TextoLimpio } from '../../../../../common/sanitizacion/texto-limpio.decorator';
import { ConsultaCatalogoDto } from '../../base/paginacion';

export class PaisRespuestaDto {
  @ApiProperty({ example: 'EC', description: 'ISO 3166-1 alfa-2; es el id en la URL' })
  code: string;

  @ApiProperty({ example: 'ECU', description: 'ISO 3166-1 alfa-3 (el de los pasaportes)' })
  iso3: string;

  @ApiProperty({ example: 'Ecuador' })
  name: string;

  @ApiProperty({ example: true })
  active: boolean;
}

export class CrearPaisDto {
  @ApiProperty({ example: 'CO' })
  @Matches(REGEX_PAIS_ISO2, { message: 'code must be a 2-letter uppercase ISO 3166-1 code' })
  code: string;

  @ApiProperty({ example: 'COL' })
  @Matches(REGEX_PAIS_ISO3, { message: 'iso3 must be a 3-letter uppercase ISO 3166-1 code' })
  iso3: string;

  @ApiProperty({ example: 'Colombia', maxLength: 100 })
  @TextoLimpio()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;
}

/** Los códigos son la identidad del país: no se cambian. */
export class ActualizarPaisDto {
  @ApiPropertyOptional({ example: 'República de Colombia', maxLength: 100 })
  @TextoLimpio()
  @IsOptional()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;
}

export class ConsultaPaisDto extends ConsultaCatalogoDto {}
