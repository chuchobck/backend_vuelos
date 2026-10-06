import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MontoDto } from '../../../compartido/dto/monto.dto';
import { ESTADO_RESERVA, EstadoReservaContrato } from '../../../compartido/enums';
import { OpcionItinerarioDto } from '../../busqueda/dto/respuesta-busqueda.dto';
import { BoletoDto } from '../../boleto/dto/boleto.dto';
import { PasajeroReservaDto } from './solicitud-reserva.dto';

/** Los DTO de esta respuesta copian components.schemas del contrato, con sus mismos nombres. */

/** BASIC de UIO-GYE para un adulto en la semilla (el precio cambia con la fecha). */
const TOTAL_EJEMPLO: MontoDto = {
  currency: 'USD',
  baseFare: '61.60',
  taxes: '12.32',
  total: '73.92',
};

/** Un elemento de BookingDetail.changes: el historial de la reserva. */
export class CambioReservaDto {
  @ApiProperty({ example: '2026-10-05T15:02:11.000Z', format: 'date-time' })
  changedAt: string;

  @ApiProperty({ example: 'Booking created from hold' })
  description: string;
}

/** components.schemas.BookingDetail (201 y 202 de POST /bookings, y GET /bookings/{id}). */
export class DetalleReservaDto {
  @ApiProperty({ format: 'uuid' })
  bookingId: string;

  @ApiProperty({ example: 'K7M2QX', description: '6 caracteres, sin 0, O, 1, I ni L' })
  pnr: string;

  @ApiProperty({ enum: ESTADO_RESERVA.valores, example: 'CONFIRMED' })
  status: EstadoReservaContrato;

  @ApiProperty({
    type: MontoDto,
    example: TOTAL_EJEMPLO,
    description: 'El precio congelado en el hold (más equipaje y cargos de cambio, si los hay)',
  })
  grandTotal: MontoDto;

  @ApiProperty({ example: '2026-10-05T15:02:11.000Z', format: 'date-time' })
  createdAt: string;

  @ApiPropertyOptional({ example: '2026-10-05T15:02:11.000Z', format: 'date-time' })
  updatedAt?: string;

  @ApiProperty({
    type: [OpcionItinerarioDto],
    description: 'pricingOptions trae solo la familia vendida, sin precio por tipo de pasajero',
  })
  itineraries: OpcionItinerarioDto[];

  @ApiProperty({ type: [PasajeroReservaDto] })
  passengers: PasajeroReservaDto[];

  @ApiProperty({ type: [BoletoDto] })
  tickets: BoletoDto[];

  @ApiProperty({ type: [CambioReservaDto] })
  changes: CambioReservaDto[];
}

/** Un elemento de BookingListResponse.items. */
export class ResumenReservaDto {
  @ApiProperty({ format: 'uuid' })
  bookingId: string;

  @ApiProperty({ example: 'K7M2QX' })
  pnr: string;

  @ApiProperty({ enum: ESTADO_RESERVA.valores, example: 'CONFIRMED' })
  status: EstadoReservaContrato;

  @ApiProperty({ example: 'UIO', description: 'Origen del primer itinerario' })
  origin: string;

  @ApiProperty({ example: 'GYE', description: 'Destino del primer itinerario' })
  destination: string;

  @ApiProperty({
    example: '2026-10-25',
    format: 'date',
    description: 'Fecha local de la primera salida',
  })
  departureDate: string;

  @ApiProperty({ type: MontoDto, example: TOTAL_EJEMPLO })
  grandTotal: MontoDto;
}

/** components.schemas.BookingListResponse. Sin nextCursor, no hay más páginas. */
export class ListaReservasDto {
  @ApiPropertyOptional({ description: 'Se pasa como `cursor` para la página siguiente' })
  nextCursor?: string;

  @ApiProperty({ type: [ResumenReservaDto] })
  items: ResumenReservaDto[];
}
