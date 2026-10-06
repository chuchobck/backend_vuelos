import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  CABINA,
  CabinaContrato,
  ESTADO_VUELO,
  EstadoVueloContrato,
  TIPO_PASAJERO,
  TipoPasajeroContrato,
} from '../../../compartido/enums';
import { MontoDto } from '../../../compartido/dto/monto.dto';

/** Los DTO de esta respuesta copian components.schemas del contrato, con sus mismos nombres. */

export class AerolineaOfertaDto {
  @ApiProperty({ example: 'AV' })
  code: string;

  @ApiProperty({ example: 'Avianca' })
  name: string;
}

/** FlightEndpoint. */
export class ExtremoVueloDto {
  @ApiProperty({ example: 'UIO', pattern: '^[A-Z]{3}$' })
  iataCode: string;

  @ApiProperty({ example: '2026-10-20T12:30:00.000Z', format: 'date-time', description: 'UTC' })
  at: string;

  @ApiPropertyOptional({ example: null, nullable: true })
  terminal: string | null;
}

/** FlightSegment: una salida programada. */
export class SegmentoVueloDto {
  @ApiProperty({ format: 'uuid', description: 'Id de la salida; es el segmentId del seatmap' })
  segmentId: string;

  @ApiProperty({ example: 'AV1500' })
  flightNumber: string;

  @ApiProperty({ type: ExtremoVueloDto })
  departure: ExtremoVueloDto;

  @ApiProperty({ type: ExtremoVueloDto })
  arrival: ExtremoVueloDto;

  @ApiPropertyOptional({ example: 65, description: 'Espera desde el segmento anterior' })
  layoverMinutes?: number;

  @ApiProperty({ example: 'AV' })
  marketingCarrier: string;

  @ApiProperty({ example: 'AV' })
  operatingCarrier: string;

  @ApiPropertyOptional({ example: '320', nullable: true })
  aircraft: string | null;

  @ApiPropertyOptional({ example: 55, minimum: 0, nullable: true })
  durationMinutes: number | null;

  @ApiPropertyOptional({ enum: ESTADO_VUELO.valores, example: 'SCHEDULED', nullable: true })
  status: EstadoVueloContrato | null;
}

export class ReglasTarifaDto {
  @ApiProperty({ example: false })
  isRefundable: boolean;

  @ApiProperty({ example: true })
  isChangeable: boolean;
}

export class EquipajeIncluidoDto {
  @ApiPropertyOptional({ example: true })
  personalItemIncluded: boolean;

  @ApiPropertyOptional({ example: 1 })
  carryOnIncluded: number;

  @ApiPropertyOptional({ example: 0 })
  checkedBaggageIncluded: number;
}

export class PrecioPorPasajeroDto {
  @ApiPropertyOptional({ enum: TIPO_PASAJERO.valores, example: 'ADULT' })
  passengerType: TipoPasajeroContrato;

  @ApiPropertyOptional({ type: MontoDto, description: 'Precio de un pasajero de ese tipo' })
  price: MontoDto;
}

/** CabinPricing: una familia tarifaria con cupo en todos los segmentos del itinerario. */
export class PrecioCabinaDto {
  @ApiProperty({ enum: CABINA.valores, example: 'ECONOMY' })
  cabinClass: CabinaContrato;

  @ApiProperty({ example: 'BASIC' })
  fareBrand: string;

  @ApiProperty({ example: 126, description: 'El menor cupo disponible entre los segmentos' })
  availableSeats: number;

  @ApiProperty({ type: ReglasTarifaDto })
  fareRules: ReglasTarifaDto;

  @ApiProperty({ type: EquipajeIncluidoDto })
  baggageAllowance: EquipajeIncluidoDto;

  @ApiPropertyOptional({ type: MontoDto, description: 'Por maleta adicional en el itinerario' })
  extraCheckedBaggagePrice: MontoDto;

  @ApiProperty({ type: [PrecioPorPasajeroDto], description: 'Solo los tipos pedidos' })
  pricePerPassengerType: PrecioPorPasajeroDto[];
}

/** ItineraryOption: la opción elegida para un tramo pedido. */
export class OpcionItinerarioDto {
  @ApiProperty({ format: 'uuid', description: 'Se usa en itinerarySelections del hold' })
  itineraryId: string;

  @ApiProperty({ example: 55 })
  totalDurationMinutes: number;

  @ApiProperty({ example: 0 })
  stopsCount: number;

  @ApiProperty({ type: [SegmentoVueloDto] })
  segments: SegmentoVueloDto[];

  @ApiProperty({ type: [PrecioCabinaDto], description: 'De la más barata a la más cara' })
  pricingOptions: PrecioCabinaDto[];
}

/** FlightOffer: una opción por tramo pedido, de una sola aerolínea. */
export class OfertaVueloDto {
  @ApiProperty({ format: 'uuid' })
  offerId: string;

  @ApiProperty({ type: AerolineaOfertaDto })
  airline: AerolineaOfertaDto;

  @ApiProperty({ type: [OpcionItinerarioDto], description: 'En el orden de los tramos pedidos' })
  itineraries: OpcionItinerarioDto[];

  @ApiProperty({
    type: MontoDto,
    description: 'Todos los pasajeros con la familia más barata de cada itinerario',
  })
  grandTotal: MontoDto;
}

/** SearchResponse. */
export class RespuestaBusquedaDto {
  @ApiProperty({ example: 2, description: 'Ofertas devueltas en `offers`' })
  totalOffers: number;

  @ApiProperty({ type: [OfertaVueloDto] })
  offers: OfertaVueloDto[];
}
