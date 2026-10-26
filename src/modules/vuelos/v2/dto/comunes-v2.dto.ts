import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { REGEX_REFERENCIA_PAGO } from '../../operaciones/reserva/dto/solicitud-reserva.dto';

/** Un monto en texto (`"73.92"`), nunca un número: hasta 10 enteros y 2 decimales. */
const REGEX_MONTO = /^\d{1,10}(\.\d{1,2})?$/;
const MONTO = { message: '$property must be an amount as text, like "73.92"' };

/** components.schemas.Link. */
export class EnlaceDto {
  @ApiProperty({ example: '/api/v2/vuelos/bookings/7c9e6679-7425-40de-944b-e07fc1f90ae7' })
  href: string;

  @ApiPropertyOptional({ enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], example: 'GET' })
  method?: string;
}

/** `_links` (components.schemas.Links), documentado como un mapa de Link. */
export const ENLACES_SWAGGER = {
  type: 'object',
  additionalProperties: { $ref: '#/components/schemas/EnlaceDto' },
  example: {
    self: { href: '/api/v2/vuelos/bookings/7c9e6679-7425-40de-944b-e07fc1f90ae7', method: 'GET' },
  },
} as const;

/** components.schemas.MoneyAmount, como entra (payment.amount). */
export class MontoEntradaDto {
  @ApiProperty({ example: 'USD', pattern: '^[A-Z]{3}$' })
  @Matches(/^[A-Z]{3}$/, { message: '$property must be an ISO 4217 code like USD' })
  currency: string;

  @ApiPropertyOptional({ example: '60.00' })
  @IsOptional()
  @Matches(REGEX_MONTO, MONTO)
  baseFare?: string;

  @ApiPropertyOptional({ example: '13.92' })
  @IsOptional()
  @Matches(REGEX_MONTO, MONTO)
  taxes?: string;

  @ApiProperty({ example: '73.92' })
  @Matches(REGEX_MONTO, MONTO)
  total: string;
}

export const PROVEEDORES_PAGO = ['BOOKING_PROTOTIPO', 'AIRLINE_DIRECT'] as const;
export type ProveedorPagoContrato = (typeof PROVEEDORES_PAGO)[number];

/**
 * components.schemas.PaymentReference del contrato v2 (additionalProperties: false). La
 * aerolínea no procesa tarjetas: con BOOKING_PROTOTIPO (por defecto) cobró Booking y aquí solo se
 * valida la referencia y, si llega, el monto.
 */
export class PagoV2Dto {
  @ApiProperty({
    example: 'PAY-BKP-20261023-000981',
    description:
      'Identificador del pago. Con BOOKING_PROTOTIPO, el de la pasarela de Booking; con ' +
      'AIRLINE_DIRECT, el de la Payment API (simulada: PAY-OK-…, PAY-PEND-…, PAY-REJ-…)',
  })
  @IsString()
  @Matches(REGEX_REFERENCIA_PAGO, {
    message: '$property must be 8 to 64 letters, digits or _ . : -',
  })
  paymentReference: string;

  @ApiPropertyOptional({
    type: MontoEntradaDto,
    description: 'Si llega, tiene que ser exactamente el precio (AMOUNT_MISMATCH)',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => MontoEntradaDto)
  amount?: MontoEntradaDto;

  @ApiPropertyOptional({ enum: PROVEEDORES_PAGO, default: 'BOOKING_PROTOTIPO' })
  @IsOptional()
  @IsIn(PROVEEDORES_PAGO, { message: `$property must be one of: ${PROVEEDORES_PAGO.join(', ')}` })
  provider?: ProveedorPagoContrato;
}

/** components.schemas.SalesChannel. */
export class CanalVentaDto {
  @ApiPropertyOptional({ example: 'BOOKING_PROTOTIPO', maxLength: 100 })
  @IsOptional()
  @IsString()
  @Matches(/^\S(.*\S)?$/, { message: '$property must not start or end with spaces' })
  @MaxLength(100)
  partnerId?: string;

  @ApiPropertyOptional({ example: 'ORD-BKP-55120', maxLength: 100 })
  @IsOptional()
  @IsString()
  @Matches(/^\S(.*\S)?$/, { message: '$property must not start or end with spaces' })
  @MaxLength(100)
  partnerOrderId?: string;

  @ApiPropertyOptional({ example: 'PKG-UIO-GYE-0091', nullable: true, maxLength: 100 })
  @IsOptional()
  @IsString()
  @Matches(/^\S(.*\S)?$/, { message: '$property must not start or end with spaces' })
  @MaxLength(100)
  packageId?: string | null;

  @ApiPropertyOptional({ example: false, default: false })
  @IsOptional()
  @IsBoolean()
  promotionApplied?: boolean;

  @ApiPropertyOptional({ example: 10, minimum: 0, maximum: 100 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  discountPercentage?: number;
}
