import { ApiProperty } from '@nestjs/swagger';
import {
  IsDateString,
  IsInt,
  IsNumber,
  IsPositive,
  IsString,
  Min,
  MinLength,
} from 'class-validator';

export class CreateVueloDto {
  @ApiProperty({ description: 'Aerolínea que opera el vuelo', example: 'Avianca' })
  @IsString()
  @MinLength(2)
  aerolinea: string;

  @ApiProperty({ description: 'Código del vuelo', example: 'AV123' })
  @IsString()
  @MinLength(3)
  codigoVuelo: string;

  @ApiProperty({ description: 'Código IATA del aeropuerto de origen', example: 'BOG' })
  @IsString()
  @MinLength(3)
  origenIATA: string;

  @ApiProperty({ description: 'Código IATA del aeropuerto de destino', example: 'MDE' })
  @IsString()
  @MinLength(3)
  destinoIATA: string;

  @ApiProperty({ description: 'Fecha y hora de salida', example: '2025-11-20T14:30:00Z' })
  @IsDateString()
  fechaSalida: string;

  @ApiProperty({ description: 'Fecha y hora de llegada', example: '2025-11-20T15:30:00Z' })
  @IsDateString()
  fechaLlegada: string;

  @ApiProperty({ description: 'Precio base del ticket', example: 85.5 })
  @IsNumber()
  @IsPositive()
  precioBase: number;

  @ApiProperty({ description: 'Asientos disponibles para reserva', example: 120 })
  @IsInt()
  @Min(0)
  asientosDisponibles: number;
}
