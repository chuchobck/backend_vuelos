import { applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';
import { CONTENT_TYPE_PROBLEMA } from '../../../common/errores/problem-details';
import { ProblemDetailsV2 } from '../../../common/errores/problem-details-v2';

/** Etiquetas del documento v2: los grupos de x-microservice del contrato v2. */
export const ETIQUETAS_V2 = {
  vuelos: 'MS.Vuelos — Búsqueda y Estado',
  telemetria: 'MS.Vuelos — Telemetría',
  reservas: 'MS.Reservas — Hold, Reservas y Emisión',
  checkin: 'MS.Reservas — Check-in',
  postventa: 'MS.Postventa',
} as const;

/** Un error documentado con el ProblemDetails del contrato v2. */
export function ApiProblemaV2(status: number, descripcion: string) {
  return applyDecorators(
    ApiExtraModels(ProblemDetailsV2),
    ApiResponse({
      status,
      description: descripcion,
      content: { [CONTENT_TYPE_PROBLEMA]: { schema: { $ref: getSchemaPath(ProblemDetailsV2) } } },
    }),
  );
}
