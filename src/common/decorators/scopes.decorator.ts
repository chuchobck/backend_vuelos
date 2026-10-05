import { SetMetadata } from '@nestjs/common';
import { Scope } from '../../modules/auth/scopes';

export const SCOPES_REQUERIDOS = 'scopesRequeridos';

/**
 * Scopes que debe traer el token para entrar a la ruta (todos los indicados). Sin ellos,
 * ScopesGuard responde 403 diciendo cuáles faltan. Implica JWT: no va junto con @Publico().
 *
 *   @Scopes('flights:book')
 *   @Post()
 *   crearReserva() {}
 */
export const Scopes = (...scopes: [Scope, ...Scope[]]) => SetMetadata(SCOPES_REQUERIDOS, scopes);
