import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MontoDto } from '../../../compartido/dto/monto.dto';
import { ESTADO_RETENCION, EstadoRetencionContrato } from '../../../compartido/enums';

/** Los DTO de esta respuesta copian components.schemas del contrato, con sus mismos nombres. */

const PRECIO_EJEMPLO: MontoDto = {
  currency: 'USD',
  baseFare: '150.80',
  taxes: '30.16',
  total: '180.96',
};

/** components.schemas.HoldResponse (201 de POST /offers/hold). */
export class RetencionCreadaDto {
  @ApiProperty({ format: 'uuid' })
  holdId: string;

  @ApiProperty({ enum: ['HELD'], example: 'HELD' })
  status: 'HELD';

  @ApiProperty({ example: '2026-10-05T15:15:00.000Z', format: 'date-time', description: 'UTC' })
  expiresAt: string;

  @ApiProperty({ example: 15, description: 'Vigencia del hold (HOLD_TTL_MINUTES)' })
  ttlMinutes: number;

  @ApiProperty({
    type: MontoDto,
    example: PRECIO_EJEMPLO,
    description: 'Precio congelado de todos los pasajeros y todos los itinerarios',
  })
  lockedPrice: MontoDto;
}

/** components.schemas.HoldStatusResponse (200 de GET /offers/hold/{holdId}). */
export class EstadoRetencionDto {
  @ApiProperty({ enum: ESTADO_RETENCION.valores, example: 'HELD' })
  status: EstadoRetencionContrato;

  @ApiPropertyOptional({
    example: '2026-10-05T15:15:00.000Z',
    format: 'date-time',
    description: 'Vencimiento del hold (UTC); se informa también cuando ya no está HELD',
  })
  expiresAt?: string;

  @ApiProperty({
    example: 512,
    minimum: 0,
    description: 'Segundos hasta vencer; 0 si no está HELD',
  })
  remainingSeconds: number;

  @ApiProperty({ type: MontoDto, example: PRECIO_EJEMPLO })
  lockedPrice: MontoDto;
}
