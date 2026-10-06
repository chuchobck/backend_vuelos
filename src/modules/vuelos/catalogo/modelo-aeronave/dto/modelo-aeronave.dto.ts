import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, Matches, MaxLength } from 'class-validator';
import { REGEX_IATA_MODELO } from '../../../../../common/pipes/formatos';
import { TextoLimpio } from '../../../../../common/sanitizacion/texto-limpio.decorator';
import { ConsultaCatalogoDto } from '../../base/paginacion';

export class ModeloAeronaveRespuestaDto {
  @ApiProperty({ example: '320', description: 'Código IATA del tipo de aeronave; es el id' })
  code: string;

  @ApiProperty({ example: 'Airbus A320' })
  name: string;

  @ApiProperty({ example: true })
  active: boolean;
}

export class CrearModeloAeronaveDto {
  @ApiProperty({ example: 'E90' })
  @Matches(REGEX_IATA_MODELO, { message: 'code must be a 3-character uppercase IATA code' })
  code: string;

  @ApiProperty({ example: 'Embraer E190', maxLength: 100 })
  @TextoLimpio()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;
}

/** El código es la identidad del modelo: no se cambia. */
export class ActualizarModeloAeronaveDto {
  @ApiPropertyOptional({ example: 'Embraer 190', maxLength: 100 })
  @TextoLimpio()
  @IsOptional()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;
}

export class ConsultaModeloAeronaveDto extends ConsultaCatalogoDto {}
