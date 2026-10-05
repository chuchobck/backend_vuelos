import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { STATUS_CODES } from 'node:http';
import { CodigoError } from './codigo-error';
import { ParametroInvalido } from './error-negocio';

export const CONTENT_TYPE_PROBLEMA = 'application/problem+json';

/** Base de los `type` propios; el de un error sin código específico es `about:blank` (RFC 9457). */
export const TIPO_ERROR_BASE = 'https://api.booking-hub.com/errors/';

/**
 * Cuerpo de todo error de la API. Es exactamente components.schemas.ProblemDetails del
 * contrato (additionalProperties: false): no se agregan campos.
 */
export class ProblemDetails {
  @ApiProperty({ example: 'https://api.booking-hub.com/errors/seat-taken' })
  type: string;

  @ApiProperty({ example: 'Conflict' })
  title: string;

  @ApiProperty({ example: 409 })
  status: number;

  @ApiPropertyOptional({ example: 'Seat 12A is already taken' })
  detail?: string;

  @ApiProperty({ enum: CodigoError, enumName: 'CodigoError', example: CodigoError.SEAT_TAKEN })
  code: CodigoError;

  @ApiPropertyOptional({
    type: 'array',
    items: {
      type: 'object',
      properties: { name: { type: 'string' }, reason: { type: 'string' } },
    },
  })
  invalidParams?: ParametroInvalido[];
}

/** Descripción corta del status, como en RFC 9457 (`Not Found`, `Conflict`...). */
export function tituloDeStatus(status: number): string {
  return STATUS_CODES[status] ?? 'Error';
}

/** `SEAT_TAKEN` → `https://api.booking-hub.com/errors/seat-taken`. */
export function tipoDeCodigo(codigo: CodigoError): string {
  return TIPO_ERROR_BASE + codigo.toLowerCase().replace(/_/g, '-');
}
