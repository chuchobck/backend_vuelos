import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export type EstadoNodo = 'HEALTHY' | 'DEGRADED' | 'DOWN';
export type EstadoDependencia = 'UP' | 'DOWN' | 'DEGRADED';

/** Un componente del que depende el nodo (VuelosHealthResponse.dependencias[]). */
export class DependenciaSaludDto {
  @ApiProperty({ example: 'postgres' })
  nombre: string;

  @ApiProperty({ enum: ['UP', 'DOWN', 'DEGRADED'], example: 'UP' })
  status: EstadoDependencia;

  @ApiProperty({ example: 8 })
  latencia_ms: number;
}

/**
 * components.schemas.VuelosHealthResponse del contrato v2: snake_case, como el resto de
 * verticales, para el Monitor de Nodos de Booking.
 */
export class SaludV2Dto {
  @ApiProperty({ enum: ['HEALTHY', 'DEGRADED', 'DOWN'], example: 'HEALTHY' })
  status: EstadoNodo;

  @ApiProperty({ example: 'NODE_VUE_QUINDE' })
  nodo_id: string;

  @ApiPropertyOptional({ example: 'Quinde' })
  nombre_proveedor?: string;

  @ApiProperty({ enum: ['VUELOS'], example: 'VUELOS' })
  vertical: 'VUELOS';

  @ApiProperty({ example: '2.0.0' })
  version: string;

  @ApiPropertyOptional({ example: 8420 })
  uptime_seconds?: number;

  @ApiPropertyOptional({ example: 32, description: 'Lo que tardó este chequeo' })
  latencia_ms?: number;

  @ApiPropertyOptional({ enum: ['CLOSED', 'OPEN', 'HALF_OPEN'], example: 'CLOSED' })
  circuit_breaker_estado?: 'CLOSED' | 'OPEN' | 'HALF_OPEN';

  @ApiPropertyOptional({ example: 4 })
  holds_activos_count?: number;

  @ApiPropertyOptional({ example: 12 })
  vuelos_programados_hoy?: number;

  @ApiPropertyOptional({ type: [DependenciaSaludDto] })
  dependencias?: DependenciaSaludDto[];

  @ApiProperty({ format: 'date-time', example: '2026-10-23T10:00:00.000Z' })
  timestamp: string;
}
