import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { REGEX_IATA_AEROLINEA, REGEX_IATA_MODELO } from '../../../../../common/pipes/formatos';
import { TextoLimpio } from '../../../../../common/sanitizacion/texto-limpio.decorator';
import {
  CABINA,
  CabinaContrato,
  POSICION_ASIENTO,
  PosicionContrato,
} from '../../../compartido/enums';
import { ConsultaCatalogoDto } from '../../base/paginacion';

/** Letras de asiento válidas (ck_asiento_letra): de la A a la K, sin la I. */
const REGEX_LETRA = /^[A-HJK]$/;

export class AsientoDto {
  @ApiProperty({ example: 'A', description: 'De la A a la K, sin la I' })
  @Matches(REGEX_LETRA, { message: 'letter must be one of A-H, J or K' })
  letter: string;

  @ApiProperty({ enum: POSICION_ASIENTO.valores, example: 'WINDOW' })
  @IsIn(POSICION_ASIENTO.valores)
  position: PosicionContrato;
}

export class FilaAsientosDto {
  @ApiProperty({ example: 12, minimum: 1, maximum: 99 })
  @IsInt()
  @Min(1)
  @Max(99)
  number: number;

  @ApiProperty({ enum: CABINA.valores, example: 'ECONOMY' })
  @IsIn(CABINA.valores)
  cabinClass: CabinaContrato;

  @ApiPropertyOptional({ example: false, default: false, description: 'EXTRA_LEGROOM' })
  @IsOptional()
  @IsBoolean()
  extraLegroom?: boolean;

  @ApiPropertyOptional({ example: false, default: false, description: 'EMERGENCY_EXIT' })
  @IsOptional()
  @IsBoolean()
  emergencyExit?: boolean;

  @ApiProperty({ type: [AsientoDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => AsientoDto)
  seats: AsientoDto[];
}

export class CabinaMapaDto {
  @ApiProperty({ enum: CABINA.valores, example: 'ECONOMY' })
  cabinClass: CabinaContrato;

  @ApiProperty({ example: 150, description: 'Asientos físicos de la cabina' })
  seats: number;
}

/** Lo que sale en la lista: sin las filas, para no cargar cientos de asientos por mapa. */
export class MapaAsientosResumenDto {
  @ApiProperty({ format: 'uuid', description: 'Es el id en la URL' })
  id: string;

  @ApiProperty({ example: 'AV' })
  airline: string;

  @ApiProperty({ example: '320', description: 'Modelo de aeronave (IATA)' })
  aircraftModel: string;

  @ApiProperty({ example: 'Avianca A320 · Ejecutiva + Económica' })
  name: string;

  @ApiProperty({ type: [CabinaMapaDto] })
  cabins: CabinaMapaDto[];

  @ApiProperty({ example: true })
  active: boolean;
}

export class MapaAsientosRespuestaDto extends MapaAsientosResumenDto {
  @ApiProperty({ type: [FilaAsientosDto] })
  rows: FilaAsientosDto[];
}

/**
 * El mapa nace con sus filas y asientos y esa distribución no cambia: los asientos los
 * referencian las reservas, y quitar una fila exigiría borrarla. Para otra distribución, se
 * crea un mapa nuevo y se da de baja el anterior.
 */
export class CrearMapaAsientosDto {
  @ApiProperty({ example: 'AV' })
  @Matches(REGEX_IATA_AEROLINEA, { message: 'airline must be a 2-character uppercase IATA code' })
  airline: string;

  @ApiProperty({ example: 'AT7' })
  @Matches(REGEX_IATA_MODELO, {
    message: 'aircraftModel must be a 3-character uppercase IATA code',
  })
  aircraftModel: string;

  @ApiProperty({ example: 'Avianca ATR 72 · 2 filas de prueba', maxLength: 150 })
  @TextoLimpio()
  @IsNotEmpty()
  @MaxLength(150)
  name: string;

  @ApiProperty({ type: [FilaAsientosDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(99)
  @ValidateNested({ each: true })
  @Type(() => FilaAsientosDto)
  rows: FilaAsientosDto[];
}

/** Solo el nombre: aerolínea, modelo y distribución quedan fijos al crear el mapa. */
export class ActualizarMapaAsientosDto {
  @ApiPropertyOptional({ example: 'Avianca ATR 72-600', maxLength: 150 })
  @TextoLimpio()
  @IsOptional()
  @IsNotEmpty()
  @MaxLength(150)
  name?: string;
}

export class ConsultaMapaAsientosDto extends ConsultaCatalogoDto {
  @ApiPropertyOptional({ example: 'AV' })
  @IsOptional()
  @Matches(REGEX_IATA_AEROLINEA, { message: 'airline must be a 2-character uppercase IATA code' })
  airline?: string;

  @ApiPropertyOptional({ example: '320' })
  @IsOptional()
  @Matches(REGEX_IATA_MODELO, {
    message: 'aircraftModel must be a 3-character uppercase IATA code',
  })
  aircraftModel?: string;
}
