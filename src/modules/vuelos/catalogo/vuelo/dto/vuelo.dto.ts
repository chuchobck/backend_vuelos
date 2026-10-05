import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';
import { REGEX_IATA_AEROLINEA, REGEX_IATA_AEROPUERTO } from '../../../../../common/pipes/formatos';
import { ConsultaCatalogoDto } from '../../base/paginacion';

const AEROLINEA = { message: '$property must be a 2-character uppercase IATA airline code' };
const AEROPUERTO = { message: '$property must be a 3-letter uppercase IATA airport code' };

export class VueloRespuestaDto {
  @ApiProperty({ example: 'AV1234', description: 'flightNumber del contrato; es el id' })
  flightNumber: string;

  @ApiProperty({ example: 'AV', description: 'Aerolínea que lo comercializa' })
  marketingCarrier: string;

  @ApiProperty({ example: 'AV', description: 'Aerolínea que lo opera (código compartido)' })
  operatingCarrier: string;

  @ApiProperty({ example: 'UIO' })
  origin: string;

  @ApiProperty({ example: 'GYE' })
  destination: string;

  @ApiProperty({ example: true })
  active: boolean;
}

/** Aerolínea, número y ruta son la identidad del vuelo: otra ruta es otro vuelo. */
export class CrearVueloDto {
  @ApiProperty({ example: 'AV' })
  @Matches(REGEX_IATA_AEROLINEA, AEROLINEA)
  marketingCarrier: string;

  @ApiProperty({ example: '1999', description: 'Parte numérica, sin ceros a la izquierda' })
  @Matches(/^[1-9][0-9]{0,3}$/, {
    message: 'number must be 1 to 4 digits without leading zeros',
  })
  number: string;

  @ApiPropertyOptional({ example: 'AV', description: 'Sin valor: la misma que lo comercializa' })
  @IsOptional()
  @Matches(REGEX_IATA_AEROLINEA, AEROLINEA)
  operatingCarrier?: string;

  @ApiProperty({ example: 'UIO' })
  @Matches(REGEX_IATA_AEROPUERTO, AEROPUERTO)
  origin: string;

  @ApiProperty({ example: 'LTX' })
  @Matches(REGEX_IATA_AEROPUERTO, AEROPUERTO)
  destination: string;
}

export class ActualizarVueloDto {
  @ApiPropertyOptional({ example: 'LA', description: 'Cambio de operador (código compartido)' })
  @IsOptional()
  @Matches(REGEX_IATA_AEROLINEA, AEROLINEA)
  operatingCarrier?: string;
}

export class ConsultaVueloDto extends ConsultaCatalogoDto {
  @ApiPropertyOptional({ example: 'AV', description: 'Aerolínea que lo comercializa' })
  @IsOptional()
  @Matches(REGEX_IATA_AEROLINEA, AEROLINEA)
  airline?: string;

  @ApiPropertyOptional({ example: 'UIO' })
  @IsOptional()
  @Matches(REGEX_IATA_AEROPUERTO, AEROPUERTO)
  origin?: string;

  @ApiPropertyOptional({ example: 'GYE' })
  @IsOptional()
  @Matches(REGEX_IATA_AEROPUERTO, AEROPUERTO)
  destination?: string;
}
