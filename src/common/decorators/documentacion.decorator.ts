import { applyDecorators } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';
import { CONTENT_TYPE_PROBLEMA, ProblemDetails } from '../errores/problem-details';

/** Nombre del esquema bearer de Swagger (el del botón Authorize). */
export const ESQUEMA_BEARER = 'bearer';

/** Nombre del esquema OAuth2 del contrato, el que declara los scopes de cada operación. */
export const ESQUEMA_OAUTH2 = 'OAuth2Security';

/** Respuesta de error documentada como `application/problem+json` con el esquema del contrato. */
export function ApiProblema(status: number, descripcion: string) {
  return applyDecorators(
    ApiExtraModels(ProblemDetails),
    ApiResponse({
      status,
      description: descripcion,
      content: { [CONTENT_TYPE_PROBLEMA]: { schema: { $ref: getSchemaPath(ProblemDetails) } } },
    }),
  );
}

/**
 * Solo documentación: la ruta exige un token (lo hace JwtAuthGuard, que es global, con o sin
 * este decorador). Swagger la muestra con candado y con su 401.
 */
export function DocumentarAutenticacion() {
  return applyDecorators(
    ApiBearerAuth(ESQUEMA_BEARER),
    ApiProblema(401, 'Falta el token, no es válido o venció (WWW-Authenticate: Bearer)'),
  );
}
