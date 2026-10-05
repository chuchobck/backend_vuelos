import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsUUID, Matches, MaxLength } from 'class-validator';
import { REGEX_IATA_AEROPUERTO, REGEX_PAIS_ISO2 } from '../../../../../common/pipes/formatos';
import { TextoLimpio } from '../../../../../common/sanitizacion/texto-limpio.decorator';
import { ConsultaCatalogoDto } from '../../base/paginacion';

export class AeropuertoRespuestaDto {
  @ApiProperty({ example: 'UIO', description: 'Código IATA; es el id en la URL' })
  code: string;

  @ApiProperty({ example: 'Aeropuerto Internacional Mariscal Sucre' })
  name: string;

  @ApiProperty({ format: 'uuid', description: 'Id de la ciudad (/admin/cities/{id})' })
  cityId: string;

  @ApiProperty({ example: 'Quito' })
  cityName: string;

  @ApiProperty({ example: 'EC' })
  country: string;

  @ApiProperty({ example: true })
  active: boolean;
}

export class CrearAeropuertoDto {
  @ApiProperty({ example: 'LTX' })
  @Matches(REGEX_IATA_AEROPUERTO, { message: 'code must be a 3-letter uppercase IATA code' })
  code: string;

  @ApiProperty({ example: 'Aeropuerto Internacional Cotopaxi', maxLength: 150 })
  @TextoLimpio()
  @IsNotEmpty()
  @MaxLength(150)
  name: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  cityId: string;
}

/** El código IATA es la identidad del aeropuerto: no se cambia. */
export class ActualizarAeropuertoDto {
  @ApiPropertyOptional({ example: 'Aeropuerto Cotopaxi', maxLength: 150 })
  @TextoLimpio()
  @IsOptional()
  @IsNotEmpty()
  @MaxLength(150)
  name?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  cityId?: string;
}

export class ConsultaAeropuertoDto extends ConsultaCatalogoDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Solo los de esta ciudad' })
  @IsOptional()
  @IsUUID()
  cityId?: string;

  @ApiPropertyOptional({ example: 'EC', description: 'Solo los de este país' })
  @IsOptional()
  @Matches(REGEX_PAIS_ISO2, { message: 'country must be a 2-letter uppercase ISO 3166-1 code' })
  country?: string;
}
