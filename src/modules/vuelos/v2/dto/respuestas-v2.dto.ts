import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BoletoDto } from '../../operaciones/boleto/dto/boleto.dto';
import { CheckInRespuestaDto } from '../../operaciones/checkin/dto/checkin.dto';
import { CABINA } from '../../compartido/enums';
import {
  AsientoMapaDto,
  CabinaMapaOfertaDto,
  FilaMapaDto,
  MapaAsientosOfertaDto,
} from '../../operaciones/oferta/dto/mapa-asientos-oferta.dto';
import {
  DetalleReservaDto,
  ResumenReservaDto,
} from '../../operaciones/reserva/dto/respuesta-reserva.dto';
import {
  EstadoRetencionDto,
  RetencionCreadaDto,
} from '../../operaciones/retencion/dto/respuesta-retencion.dto';
import { CanalVentaDto, ENLACES_SWAGGER } from './comunes-v2.dto';
import { Enlaces } from '../enlaces';

/** Las respuestas del contrato v2: las de v1 con `_links` y lo que v2 agrega. */

/** components.schemas.HoldResponse (v2). */
export class RetencionCreadaV2Dto extends RetencionCreadaDto {
  @ApiPropertyOptional(ENLACES_SWAGGER)
  _links?: Enlaces;
}

/** components.schemas.HoldStatusResponse (v2): suma holdId y `_links`. */
export class EstadoRetencionV2Dto extends EstadoRetencionDto {
  @ApiPropertyOptional({ format: 'uuid' })
  holdId?: string;

  @ApiPropertyOptional(ENLACES_SWAGGER)
  _links?: Enlaces;
}

export const ESTADOS_ASIENTO = [
  'AVAILABLE',
  'HELD',
  'BOOKED',
  'TICKETED',
  'CHECKED_IN',
  'BOARDED',
] as const;
export type EstadoAsiento = (typeof ESTADOS_ASIENTO)[number];

/** Un asiento del SeatMapResponse v2: suma `status` (SeatStatus). */
export class AsientoMapaV2Dto extends AsientoMapaDto {
  @ApiPropertyOptional({
    enum: ESTADOS_ASIENTO,
    example: 'AVAILABLE',
    description:
      'AVAILABLE, BOOKED (reservado), TICKETED (boleto emitido) o CHECKED_IN. Un hold toma ' +
      'cupo de cabina y no un asiento: nunca HELD. Sin status si la cabina no se vende en esta salida',
  })
  status?: EstadoAsiento;
}

export class FilaMapaV2Dto extends FilaMapaDto {
  @ApiProperty({ type: [AsientoMapaV2Dto] })
  declare seats: AsientoMapaV2Dto[];
}

export class CabinaMapaV2Dto extends CabinaMapaOfertaDto {
  @ApiProperty({ enum: CABINA.valores, example: 'ECONOMY' })
  declare cabinClass: CabinaMapaOfertaDto['cabinClass'];

  @ApiProperty({ type: [FilaMapaV2Dto] })
  declare rows: FilaMapaV2Dto[];
}

/** components.schemas.SeatMapResponse (v2). */
export class MapaAsientosV2Dto extends MapaAsientosOfertaDto {
  @ApiProperty({ type: [CabinaMapaV2Dto] })
  declare cabins: CabinaMapaV2Dto[];
}

/** components.schemas.BookingDetail (v2): suma holdId, paymentReference, salesChannel y `_links`. */
export class DetalleReservaV2Dto extends DetalleReservaDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'El hold que se convirtió en esta reserva' })
  holdId?: string;

  @ApiPropertyOptional({ example: 'PAY-BKP-20261023-000981' })
  paymentReference?: string;

  @ApiPropertyOptional({ type: CanalVentaDto })
  salesChannel?: CanalVentaDto;

  @ApiPropertyOptional(ENLACES_SWAGGER)
  _links?: Enlaces;
}

export class ResumenReservaV2Dto extends ResumenReservaDto {
  @ApiPropertyOptional(ENLACES_SWAGGER)
  _links?: Enlaces;
}

/** components.schemas.BookingListResponse (v2): nextCursor es null en la última página. */
export class ListaReservasV2Dto {
  @ApiPropertyOptional({ type: String, nullable: true, description: 'null en la última página' })
  nextCursor: string | null;

  @ApiProperty({ type: [ResumenReservaV2Dto] })
  items: ResumenReservaV2Dto[];
}

/** components.schemas.TicketIssuanceResponse. */
export class EmisionBoletosDto {
  @ApiProperty({ format: 'uuid' })
  bookingId: string;

  @ApiProperty({ example: 'XK7P2Q' })
  pnr: string;

  @ApiProperty({ enum: ['CONFIRMED', 'TICKET_ISSUING'], example: 'CONFIRMED' })
  status: 'CONFIRMED' | 'TICKET_ISSUING';

  @ApiProperty({ type: [BoletoDto] })
  tickets: BoletoDto[];

  @ApiProperty({ example: 0, description: 'Boletos emitidos en esta llamada (0 si ya estaban)' })
  issued: number;

  @ApiPropertyOptional(ENLACES_SWAGGER)
  _links?: Enlaces;
}

/** components.schemas.CheckInResponse (v2). */
export class CheckInV2Dto extends CheckInRespuestaDto {
  @ApiPropertyOptional(ENLACES_SWAGGER)
  _links?: Enlaces;
}

/** CancelBookingResponse.refund: lo calcula la aerolínea; si cobró Booking, lo ejecuta Booking. */
export class ReembolsoV2Dto {
  @ApiPropertyOptional({ format: 'uuid', description: 'El quoteId de la cancelación' })
  refundId?: string;

  @ApiPropertyOptional({ example: '58.84' })
  amount?: string;

  @ApiPropertyOptional({ example: '15.08' })
  penaltyAmount?: string;

  @ApiPropertyOptional({ example: 'USD' })
  currency?: string;

  @ApiPropertyOptional({ example: 79.6, description: 'Porcentaje de lo pagado que se devuelve' })
  percentage?: number;

  @ApiPropertyOptional({ example: 'PAY-BKP-20261023-000981' })
  originalPaymentReference?: string;

  @ApiPropertyOptional({
    enum: ['CALCULATED', 'SETTLED', 'NOT_REFUNDABLE'],
    description:
      'CALCULATED: lo ejecuta Booking (o la Payment API todavía no lo resolvió); SETTLED: ' +
      'reembolsado por la Payment API de la aerolínea; NOT_REFUNDABLE: no hay nada que devolver',
  })
  status?: 'CALCULATED' | 'SETTLED' | 'NOT_REFUNDABLE';
}

export class RestauracionInventarioDto {
  @ApiPropertyOptional({ enum: ['RESTORED', 'PENDING'], example: 'RESTORED' })
  status?: 'RESTORED' | 'PENDING';

  @ApiPropertyOptional({ example: 2 })
  seatsReleased?: number;

  @ApiPropertyOptional({ example: 'AVAILABLE' })
  newSeatStatus?: string;
}

/** components.schemas.CancelBookingResponse. */
export class CancelacionV2Dto {
  @ApiProperty({ format: 'uuid' })
  bookingId: string;

  @ApiProperty({ example: 'XK7P2Q' })
  pnr: string;

  @ApiProperty({ enum: ['CANCELLED', 'CANCELLATION_PENDING'], example: 'CANCELLED' })
  status: 'CANCELLED' | 'CANCELLATION_PENDING';

  @ApiPropertyOptional({ format: 'date-time' })
  cancelledAt?: string;

  @ApiPropertyOptional({ example: 'CUSTOMER_REQUEST' })
  reasonCode?: string;

  @ApiPropertyOptional({ type: ReembolsoV2Dto })
  refund?: ReembolsoV2Dto;

  @ApiPropertyOptional({ type: [String], example: ['1234567890123'] })
  ticketsVoided?: string[];

  @ApiPropertyOptional({ type: RestauracionInventarioDto })
  inventoryRestoration?: RestauracionInventarioDto;

  @ApiPropertyOptional({ example: 'Booking cancelled; seats released and refund calculated' })
  message?: string;

  @ApiPropertyOptional(ENLACES_SWAGGER)
  _links?: Enlaces;
}
