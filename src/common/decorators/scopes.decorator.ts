import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiSecurity } from '@nestjs/swagger';
import { Scope } from '../../modules/auth/scopes';
import { ApiProblema, DocumentarAutenticacion, ESQUEMA_OAUTH2 } from './documentacion.decorator';

export const SCOPES_REQUERIDOS = 'scopesRequeridos';

/**
 * Scopes que debe traer el token para entrar a la ruta (todos los indicados). Sin ellos,
 * ScopesGuard responde 403 diciendo cuáles faltan. Implica JWT: no va junto con @Publico().
 *
 *   @Scopes('flights:book')
 *   @Post()
 *   crearReserva() {}
 *
 * También lo documenta en Swagger como el contrato (`security: [OAuth2Security: [scopes]]`),
 * con el candado de `bearer` y las respuestas 401 y 403.
 */
export const Scopes = (...scopes: [Scope, ...Scope[]]) =>
  applyDecorators(
    SetMetadata(SCOPES_REQUERIDOS, scopes),
    ApiSecurity(ESQUEMA_OAUTH2, scopes),
    DocumentarAutenticacion(),
    ApiProblema(403, `El token no trae los scopes requeridos: ${scopes.join(', ')}`),
  );
