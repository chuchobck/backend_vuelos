import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDefined,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { TextoLimpio } from '../../../../common/sanitizacion/texto-limpio.decorator';
import { SolicitudCambioDto } from '../../operaciones/cambio-fecha/dto/cambio-fecha.dto';
import { MotivoCancelacionV2 } from '../../operaciones/cancelacion/cancelacion.service';
import { ConsultaReservasDto } from '../../operaciones/reserva/dto/consulta-reservas.dto';
import { SolicitudEquipajeDto } from '../../operaciones/equipaje/dto/equipaje.dto';
import {
  PasajeroReservaDto,
  SolicitudReservaDto,
} from '../../operaciones/reserva/dto/solicitud-reserva.dto';
import { SolicitudRetencionDto } from '../../operaciones/retencion/dto/solicitud-retencion.dto';
import { CanalVentaDto, PagoV2Dto } from './comunes-v2.dto';

/** Los DTO de entrada del contrato v2: los de v1 con lo que v2 agrega o cambia. */

/** HoldRequest.ttlMinutes: de 5 a 30, 15 por defecto. */
export const TTL_HOLD_V2 = { minimo: 5, maximo: 30, porDefecto: 15 };

/** components.schemas.HoldRequest (v2): el de v1 más ttlMinutes. */
export class SolicitudRetencionV2Dto extends SolicitudRetencionDto {
  @ApiPropertyOptional({
    minimum: TTL_HOLD_V2.minimo,
    maximum: TTL_HOLD_V2.maximo,
    default: TTL_HOLD_V2.porDefecto,
    description: 'Minutos que el hold retiene el cupo',
  })
  @IsOptional()
  @IsInt()
  @Min(TTL_HOLD_V2.minimo)
  @Max(TTL_HOLD_V2.maximo)
  ttlMinutes?: number;
}

/** BookingRequest.passengers: hasta 9 en el contrato v2 (v1 admite 18 con los infantes). */
export const MAXIMO_PASAJEROS_V2 = 9;

/** components.schemas.BookingRequest (v2): payment con monto y proveedor, más salesChannel. */
export class SolicitudReservaV2Dto extends OmitType(SolicitudReservaDto, [
  'passengers',
  'payment',
] as const) {
  @ApiProperty({ type: [PasajeroReservaDto], minItems: 1, maxItems: MAXIMO_PASAJEROS_V2 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAXIMO_PASAJEROS_V2)
  @ValidateNested({ each: true })
  @Type(() => PasajeroReservaDto)
  passengers: PasajeroReservaDto[];

  @ApiProperty({ type: PagoV2Dto })
  @IsDefined()
  @ValidateNested()
  @Type(() => PagoV2Dto)
  payment: PagoV2Dto;

  @ApiPropertyOptional({ type: CanalVentaDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CanalVentaDto)
  salesChannel?: CanalVentaDto;
}

/** components.schemas.AddBaggageRequest (v2): payment con monto y proveedor. */
export class SolicitudEquipajeV2Dto extends OmitType(SolicitudEquipajeDto, ['payment'] as const) {
  @ApiProperty({ type: PagoV2Dto })
  @IsDefined()
  @ValidateNested()
  @Type(() => PagoV2Dto)
  payment: PagoV2Dto;
}

/** components.schemas.DateChangeRequest (v2): payment con monto y proveedor. */
export class SolicitudCambioV2Dto extends OmitType(SolicitudCambioDto, ['payment'] as const) {
  @ApiPropertyOptional({ type: PagoV2Dto, description: 'Obligatorio si totalToPay es mayor que 0' })
  @IsOptional()
  @ValidateNested()
  @Type(() => PagoV2Dto)
  payment?: PagoV2Dto;
}

export const MOTIVOS_CANCELACION: readonly MotivoCancelacionV2[] = [
  'CUSTOMER_REQUEST',
  'SAGA_COMPENSATION',
  'FLIGHT_CANCELLED',
  'OTHER',
];

/** components.schemas.CancelBookingRequest (v2). */
export class SolicitudCancelacionV2Dto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Obligatorio salvo reasonCode SAGA_COMPENSATION o FLIGHT_CANCELLED',
  })
  @IsOptional()
  @IsUUID('all', { message: '$property must be a UUID' })
  quoteId?: string;

  @ApiPropertyOptional({ enum: MOTIVOS_CANCELACION, default: 'CUSTOMER_REQUEST' })
  @IsOptional()
  @IsIn(MOTIVOS_CANCELACION, {
    message: `$property must be one of: ${MOTIVOS_CANCELACION.join(', ')}`,
  })
  reasonCode?: MotivoCancelacionV2;

  @ApiPropertyOptional({ example: 'Cambio de planes', maxLength: 500 })
  @IsOptional()
  @TextoLimpio()
  @IsNotEmpty()
  @MaxLength(500)
  reason?: string;
}

/** BookingListResponse: `limit` de 1 a 50, 10 por defecto (contrato v2, parámetro Limit). */
export const LIMITE_LISTADO_V2 = { maximo: 50, porDefecto: 10 };

/** Query de GET /api/v2/vuelos/bookings: la de v1 con el `limit` del contrato v2. */
export class ConsultaReservasV2Dto extends OmitType(ConsultaReservasDto, ['limit'] as const) {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: LIMITE_LISTADO_V2.maximo,
    default: LIMITE_LISTADO_V2.porDefecto,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LIMITE_LISTADO_V2.maximo)
  limit?: number;
}
