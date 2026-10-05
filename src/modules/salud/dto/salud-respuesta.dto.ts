import { ApiProperty } from '@nestjs/swagger';

export type EstadoComponente = 'UP' | 'DOWN';

export class SaludRespuestaDto {
  @ApiProperty({ enum: ['UP', 'DOWN'], description: 'Estado general de la API' })
  status: EstadoComponente;

  @ApiProperty({ enum: ['UP', 'DOWN'], description: 'Resultado de SELECT 1 contra PostgreSQL' })
  database: EstadoComponente;

  @ApiProperty({ example: '2026-10-05T19:00:00.000Z', description: 'Hora del servidor (UTC)' })
  timestamp: string;
}
