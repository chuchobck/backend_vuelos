import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { REGEX_NUMERO_VUELO } from '../../../../../common/pipes/formatos';
import { TextoLimpio } from '../../../../../common/sanitizacion/texto-limpio.decorator';
import {
  CABINA,
  CabinaContrato,
  ESTADO_VUELO,
  EstadoVueloContrato,
} from '../../../compartido/enums';
import { ConsultaCatalogoDto } from '../../base/paginacion';

const INSTANTE = { strict: true, strictSeparator: true };
const MENSAJE_INSTANTE = {
  message: '$property must be an ISO 8601 date-time with time zone, such as 2026-11-02T13:00:00Z',
};
/** Exige zona (Z u offset): un instante sin zona sería ambiguo. */
const CON_ZONA = /(Z|[+-]\d{2}:\d{2})$/;
const MENSAJE_FECHA = { message: '$property must be a date in YYYY-MM-DD format' };

/** Estados que se fijan por PATCH. CANCELLED no: cancelar es DELETE y deshacerlo, reactivate. */
export const ESTADOS_EDITABLES = ESTADO_VUELO.valores.filter((e) => e !== 'CANCELLED');

export class CupoCabinaDto {
  @ApiProperty({ enum: CABINA.valores, example: 'ECONOMY' })
  @IsIn(CABINA.valores)
  cabinClass: CabinaContrato;

  @ApiProperty({
    example: 120,
    minimum: 0,
    description: 'Cupo que se vende; a lo sumo los asientos físicos de esa cabina del mapa',
  })
  @IsInt()
  @Min(0)
  @Max(999)
  totalSeats: number;
}

export class CupoCabinaRespuestaDto extends CupoCabinaDto {
  @ApiProperty({ example: 118, description: 'availableSeats: lo que queda para retener' })
  availableSeats: number;
}

export class VueloProgramadoRespuestaDto {
  @ApiProperty({ format: 'uuid', description: 'segmentId del contrato; es el id en la URL' })
  id: string;

  @ApiProperty({ example: 'AV1234' })
  flightNumber: string;

  @ApiProperty({ example: 'UIO' })
  origin: string;

  @ApiProperty({ example: 'GYE' })
  destination: string;

  @ApiProperty({
    example: '2026-11-02',
    format: 'date',
    description: 'Fecha local de salida en el aeropuerto de origen',
  })
  departureDate: string;

  @ApiProperty({ example: '2026-11-02T13:00:00.000Z', format: 'date-time' })
  scheduledDeparture: string;

  @ApiProperty({ example: '2026-11-02T13:50:00.000Z', format: 'date-time' })
  scheduledArrival: string;

  @ApiProperty({ format: 'date-time', nullable: true })
  estimatedDeparture: string | null;

  @ApiProperty({ format: 'date-time', nullable: true })
  estimatedArrival: string | null;

  @ApiProperty({ format: 'date-time', nullable: true })
  actualDeparture: string | null;

  @ApiProperty({ format: 'date-time', nullable: true })
  actualArrival: string | null;

  @ApiProperty({ example: '1', nullable: true })
  departureTerminal: string | null;

  @ApiProperty({ example: null, nullable: true })
  arrivalTerminal: string | null;

  @ApiProperty({ enum: ESTADO_VUELO.valores, example: 'SCHEDULED' })
  status: EstadoVueloContrato;

  @ApiProperty({ format: 'uuid', description: 'Mapa de asientos (/admin/seat-maps/{id})' })
  seatMapId: string;

  @ApiProperty({ example: '320', description: 'aircraft del contrato' })
  aircraftModel: string;

  @ApiProperty({ type: [CupoCabinaRespuestaDto] })
  cabins: CupoCabinaRespuestaDto[];

  @ApiProperty({ example: true, description: 'false si está cancelada' })
  active: boolean;
}

/** Terminales, en común para crear y modificar. */
class TerminalesDto {
  @ApiPropertyOptional({ example: '1', nullable: true, maxLength: 10 })
  @IsOptional()
  @ValidateIf((_dto, valor) => valor !== null)
  @TextoLimpio()
  @MaxLength(10)
  departureTerminal?: string | null;

  @ApiPropertyOptional({ example: null, nullable: true, maxLength: 10 })
  @IsOptional()
  @ValidateIf((_dto, valor) => valor !== null)
  @TextoLimpio()
  @MaxLength(10)
  arrivalTerminal?: string | null;
}

/**
 * Una salida nueva y sus cupos por cabina, en la misma transacción. La fecha local de salida
 * no se envía: la calcula la API con la zona horaria de la ciudad de origen. Sin `cabins`,
 * cada cabina del mapa vende todos sus asientos físicos.
 */
export class CrearVueloProgramadoDto extends TerminalesDto {
  @ApiProperty({ example: 'AV1234' })
  @Matches(REGEX_NUMERO_VUELO, { message: 'flightNumber must be a flight number such as AV1234' })
  flightNumber: string;

  @ApiProperty({ format: 'uuid', description: 'De la aerolínea que opera el vuelo' })
  @IsUUID()
  seatMapId: string;

  @ApiProperty({ example: '2026-11-02T13:00:00Z', format: 'date-time' })
  @IsISO8601(INSTANTE, MENSAJE_INSTANTE)
  @Matches(CON_ZONA, MENSAJE_INSTANTE)
  scheduledDeparture: string;

  @ApiProperty({ example: '2026-11-02T13:50:00Z', format: 'date-time' })
  @IsISO8601(INSTANTE, MENSAJE_INSTANTE)
  @Matches(CON_ZONA, MENSAJE_INSTANTE)
  scheduledArrival: string;

  @ApiPropertyOptional({ type: [CupoCabinaDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => CupoCabinaDto)
  cabins?: CupoCabinaDto[];
}

/** Instante opcional que también se puede borrar con null. */
function InstanteOpcional() {
  return (objeto: object, propiedad: string) => {
    IsOptional()(objeto, propiedad);
    ValidateIf((_dto, valor) => valor !== null)(objeto, propiedad);
    IsISO8601(INSTANTE, MENSAJE_INSTANTE)(objeto, propiedad);
    Matches(CON_ZONA, MENSAJE_INSTANTE)(objeto, propiedad);
  };
}

/**
 * Horarios, terminales, estado operativo y cupos. El vuelo y el mapa de asientos de una
 * salida no cambian. Un cupo nuevo no puede quedar por debajo de lo ya retenido o vendido.
 */
export class ActualizarVueloProgramadoDto extends TerminalesDto {
  @ApiPropertyOptional({ example: '2026-11-02T13:30:00Z', format: 'date-time' })
  @IsOptional()
  @IsISO8601(INSTANTE, MENSAJE_INSTANTE)
  @Matches(CON_ZONA, MENSAJE_INSTANTE)
  scheduledDeparture?: string;

  @ApiPropertyOptional({ example: '2026-11-02T14:20:00Z', format: 'date-time' })
  @IsOptional()
  @IsISO8601(INSTANTE, MENSAJE_INSTANTE)
  @Matches(CON_ZONA, MENSAJE_INSTANTE)
  scheduledArrival?: string;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  @InstanteOpcional()
  estimatedDeparture?: string | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  @InstanteOpcional()
  estimatedArrival?: string | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  @InstanteOpcional()
  actualDeparture?: string | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  @InstanteOpcional()
  actualArrival?: string | null;

  @ApiPropertyOptional({ enum: ESTADOS_EDITABLES, example: 'DELAYED' })
  @IsOptional()
  @IsIn(ESTADOS_EDITABLES, {
    message: `status must be one of: ${ESTADOS_EDITABLES.join(', ')} (to cancel, use DELETE)`,
  })
  status?: EstadoVueloContrato;

  @ApiPropertyOptional({ type: [CupoCabinaDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => CupoCabinaDto)
  cabins?: CupoCabinaDto[];
}

export class ConsultaVueloProgramadoDto extends ConsultaCatalogoDto {
  @ApiPropertyOptional({ example: 'AV1234' })
  @IsOptional()
  @Matches(REGEX_NUMERO_VUELO, { message: 'flightNumber must be a flight number such as AV1234' })
  flightNumber?: string;

  @ApiPropertyOptional({ example: '2026-11-01', description: 'Fecha local de salida, desde' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, MENSAJE_FECHA)
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-11-30', description: 'Fecha local de salida, hasta' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, MENSAJE_FECHA)
  dateTo?: string;

  @ApiPropertyOptional({ enum: ESTADO_VUELO.valores })
  @IsOptional()
  @IsIn(ESTADO_VUELO.valores)
  status?: EstadoVueloContrato;
}
