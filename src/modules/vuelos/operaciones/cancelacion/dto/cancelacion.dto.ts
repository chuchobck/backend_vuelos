import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsUUID, MaxLength } from 'class-validator';
import { TextoLimpio } from '../../../../../common/sanitizacion/texto-limpio.decorator';

/** Los DTO copian components.schemas del contrato, con sus mismos nombres. */

/** components.schemas.CancellationQuoteResponse. */
export class CotizacionCancelacionDto {
  @ApiProperty({ format: 'uuid' })
  quoteId: string;

  @ApiProperty({ example: true, description: 'Si se devuelve algo (refundAmount mayor que 0)' })
  isRefundable: boolean;

  @ApiProperty({ example: '58.84' })
  refundAmount: string;

  @ApiProperty({ example: '15.08' })
  penaltyAmount: string;

  @ApiProperty({ example: 'USD' })
  currency: string;

  @ApiProperty({ example: '2026-10-06T15:15:00.000Z', format: 'date-time' })
  expiresAt: string;
}

/** components.schemas.CancelBookingRequest. */
export class SolicitudCancelacionDto {
  @ApiProperty({ format: 'uuid', description: 'quoteId de GET .../cancellation-quote' })
  @IsUUID('all', { message: '$property must be a UUID' })
  quoteId: string;

  @ApiPropertyOptional({ example: 'Cambio de planes', maxLength: 500 })
  @IsOptional()
  @TextoLimpio()
  @IsNotEmpty()
  @MaxLength(500)
  reason?: string;
}
