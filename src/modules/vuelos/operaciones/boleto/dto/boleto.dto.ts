import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ESTADO_BOLETO,
  ESTADO_CUPON,
  EstadoBoletoContrato,
  EstadoCuponContrato,
} from '../../../compartido/enums';

/** Los DTO de esta respuesta copian components.schemas del contrato, con sus mismos nombres. */

/** components.schemas.TicketSegment: un cupón del boleto, uno por vuelo. */
export class SegmentoBoletoDto {
  @ApiProperty({ format: 'uuid', description: 'segmentId del vuelo' })
  segmentId: string;

  @ApiProperty({ enum: ESTADO_CUPON.valores, example: 'ISSUED' })
  status: EstadoCuponContrato;

  @ApiPropertyOptional({ example: '1', nullable: true, description: 'null hasta que se emite' })
  couponNumber: string | null;
}

/** components.schemas.Ticket. */
export class BoletoDto {
  @ApiProperty({ format: 'uuid' })
  ticketId: string;

  @ApiProperty({ format: 'uuid' })
  bookingId: string;

  @ApiProperty({ example: 'PAX1', description: 'passengerId del pasajero en la reserva' })
  passengerId: string;

  @ApiPropertyOptional({
    example: '1342584736201',
    nullable: true,
    description: 'Prefijo de 3 dígitos de la aerolínea y 10 dígitos; null hasta que se emite',
  })
  eTicketNumber: string | null;

  @ApiProperty({ enum: ESTADO_BOLETO.valores, example: 'ISSUED' })
  status: EstadoBoletoContrato;

  @ApiPropertyOptional({ example: '2026-10-05T15:02:11.000Z', format: 'date-time', nullable: true })
  issuedAt: string | null;

  @ApiProperty({ type: [SegmentoBoletoDto] })
  segments: SegmentoBoletoDto[];

  @ApiPropertyOptional({ example: null, nullable: true })
  failureReason: string | null;
}

/** components.schemas.TicketListResponse. */
export class ListaBoletosDto {
  @ApiProperty({ format: 'uuid' })
  bookingId: string;

  @ApiProperty({ type: [BoletoDto] })
  tickets: BoletoDto[];
}
