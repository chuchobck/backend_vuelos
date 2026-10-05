import { ApiProperty } from '@nestjs/swagger';
import { BaseResponseDto } from '../../../common/dto/base-response.dto';

export class VueloResponseDto extends BaseResponseDto {
  @ApiProperty({
    description: 'UUID único del vuelo',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  id: string;

  @ApiProperty({ description: 'Aerolínea que opera el vuelo', example: 'Avianca' })
  aerolinea: string;

  @ApiProperty({ description: 'Código del vuelo', example: 'AV123' })
  codigoVuelo: string;

  @ApiProperty({ description: 'Código IATA del aeropuerto de origen', example: 'BOG' })
  origenIATA: string;

  @ApiProperty({ description: 'Código IATA del aeropuerto de destino', example: 'MDE' })
  destinoIATA: string;

  @ApiProperty({ description: 'Fecha y hora de salida', example: '2025-11-20T14:30:00Z' })
  fechaSalida: string;

  @ApiProperty({ description: 'Fecha y hora de llegada', example: '2025-11-20T15:30:00Z' })
  fechaLlegada: string;

  @ApiProperty({ description: 'Precio base del ticket', example: 85.5 })
  precioBase: number;

  @ApiProperty({ description: 'Asientos disponibles para reserva', example: 120 })
  asientosDisponibles: number;
}
