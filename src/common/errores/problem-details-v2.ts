import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CodigoErrorV2, codigoV2PorDefecto } from './codigo-error-v2';
import { ErrorNegocio, ParametroInvalido } from './error-negocio';
import { ProblemDetails, TIPO_ERROR_BASE, tituloDeStatus } from './problem-details';

/** Prefijo de las rutas de la fachada v2: sus errores salen con ProblemDetailsV2. */
export const PREFIJO_RUTAS_V2 = '/api/v2/';

export function esRutaV2(ruta: string): boolean {
  return ruta.startsWith(PREFIJO_RUTAS_V2);
}

/**
 * Cuerpo de todo error de /api/v2. Es exactamente components.schemas.ProblemDetails del
 * contrato v2 (additionalProperties: false): los de v1 más `instance`, `correlation_id` y
 * `timestamp` (snake_case como en el resto de verticales), con el `code` del enum v2.
 */
export class ProblemDetailsV2 {
  @ApiProperty({ example: 'https://api.booking-hub.com/errors/hold-expired' })
  type: string;

  @ApiProperty({ example: 'Gone' })
  title: string;

  @ApiProperty({ example: 410 })
  status: number;

  @ApiPropertyOptional({ example: 'Hold 3f1c2a9e-... has expired or was released' })
  detail?: string;

  @ApiPropertyOptional({ example: '/api/v2/vuelos/bookings' })
  instance?: string;

  @ApiProperty({ enum: CodigoErrorV2, enumName: 'CodigoErrorV2', example: 'HOLD_EXPIRED' })
  code: CodigoErrorV2;

  @ApiPropertyOptional({ example: 'corr-vuelos-7f3a9c' })
  correlation_id?: string;

  @ApiPropertyOptional({ format: 'date-time', example: '2026-10-23T10:16:02.000Z' })
  timestamp?: string;

  @ApiPropertyOptional({
    type: 'array',
    items: {
      type: 'object',
      properties: { name: { type: 'string' }, reason: { type: 'string' } },
    },
  })
  invalidParams?: ParametroInvalido[];
}

/**
 * El ProblemDetails v1 que ya armó traducirExcepcion, en la forma de v2. El `code` y el status
 * salen de la pista `v2` del ErrorNegocio si la trae; si no, del status (401 UNAUTHORIZED, 404
 * NOT_FOUND, 500 INTERNAL_ERROR, 503 PROVIDER_UNAVAILABLE...) o el mismo de v1. `type` sigue al
 * `code`. `instance` es la ruta pedida, sin la query; `timestamp`, la hora del error.
 */
export function aProblemaV2(
  problema: ProblemDetails,
  excepcion: unknown,
  datos: { instancia: string; correlationId?: string; ahora: Date },
): ProblemDetailsV2 {
  const pista = excepcion instanceof ErrorNegocio ? excepcion.v2 : undefined;
  const status = pista?.status ?? problema.status;
  const code = pista?.code ?? codigoV2PorDefecto(problema.status, problema.code);
  const generico =
    problema.type === 'about:blank' && code === codigoV2PorDefecto(status, problema.code);
  const v2: ProblemDetailsV2 = {
    type: generico ? 'about:blank' : TIPO_ERROR_BASE + code.toLowerCase().replace(/_/g, '-'),
    title: status === problema.status ? problema.title : tituloDeStatus(status),
    status,
    detail: problema.detail,
    instance: datos.instancia,
    code,
    correlation_id: datos.correlationId,
    timestamp: datos.ahora.toISOString(),
    invalidParams: problema.invalidParams,
  };
  return Object.fromEntries(
    Object.entries(v2).filter(([, valor]) => valor !== undefined),
  ) as unknown as ProblemDetailsV2;
}
