import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { FechaIso } from '../../../compartido/dto/validadores';
import { ESTADO_VUELO, EstadoVueloContrato } from '../../../compartido/enums';

/** Query de GET /airports/{iataCode}/departures. */
export class ConsultaSalidasDto {
  @ApiPropertyOptional({
    format: 'date',
    example: '2026-10-20',
    description: 'Fecha LOCAL del aeropuerto (YYYY-MM-DD). Sin ella, hoy en su zona horaria',
  })
  @IsOptional()
  @FechaIso()
  date?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'El `nextCursor` de la página anterior' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9_-]+$/, { message: 'cursor is not valid' })
  cursor?: string;
}

export class AeropuertoSalidasDto {
  @ApiProperty({ example: 'UIO' })
  iataCode: string;

  @ApiProperty({ example: 'Aeropuerto Internacional Mariscal Sucre' })
  name: string;

  @ApiProperty({ example: 'Quito' })
  city: string;

  @ApiProperty({ example: 'America/Guayaquil', description: 'Zona horaria IANA de las horas' })
  timeZone: string;
}

export class DestinoSalidaDto {
  @ApiProperty({ example: 'GYE' })
  iataCode: string;

  @ApiProperty({ example: 'Guayaquil' })
  city: string;
}

export class SalidaPublicaDto {
  @ApiProperty({ example: 'LA1400' })
  flightNumber: string;

  @ApiProperty({ example: 'LATAM Airlines Ecuador' })
  airline: string;

  @ApiProperty({ type: DestinoSalidaDto })
  destination: DestinoSalidaDto;

  @ApiProperty({
    example: '2026-10-20T06:30:00-05:00',
    description: 'Hora programada, en hora local del aeropuerto con su desplazamiento',
  })
  scheduledTime: string;

  @ApiProperty({
    example: null,
    nullable: true,
    description: 'Hora estimada, en hora local del aeropuerto; null mientras no se conozca',
  })
  estimatedTime: string | null;

  @ApiProperty({ enum: ESTADO_VUELO.valores, example: 'SCHEDULED' })
  status: EstadoVueloContrato;

  @ApiProperty({ example: null, nullable: true })
  terminal: string | null;

  @ApiProperty({ example: 'A3', nullable: true, description: 'null mientras no se asigne' })
  gate: string | null;
}

export class SalidasPublicasDto {
  @ApiProperty({ type: AeropuertoSalidasDto })
  airport: AeropuertoSalidasDto;

  @ApiProperty({ example: '2026-10-20', format: 'date', description: 'La fecha local pedida' })
  date: string;

  @ApiProperty({ type: [SalidaPublicaDto], description: 'Por hora programada' })
  departures: SalidaPublicaDto[];

  @ApiPropertyOptional({
    description: 'Pásalo como `cursor` para la siguiente. Sin él, no hay más',
  })
  nextCursor?: string;
}
