import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CODIGO_SIN_EQUIVALENTE } from '../errores/codigo-error';
import { ErrorNegocio } from '../errores/error-negocio';
import { SCOPES_REQUERIDOS } from '../decorators/scopes.decorator';
import { PeticionAutenticada } from '../decorators/usuario-actual.decorator';
import { desafioBearer } from '../../modules/auth/errores-auth';

/**
 * Guard global, el último: si la ruta lleva @Scopes(...), el token debe traerlos todos.
 * Si falta alguno responde 403 diciendo cuáles (RFC 6750: `error="insufficient_scope"`).
 * El contrato no trae un `code` para 403: va el de respaldo y el status dice qué pasó.
 */
@Injectable()
export class ScopesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(contexto: ExecutionContext): boolean {
    const requeridos = this.reflector.getAllAndOverride<string[] | undefined>(SCOPES_REQUERIDOS, [
      contexto.getHandler(),
      contexto.getClass(),
    ]);
    if (!requeridos || requeridos.length === 0) return true;

    // Sin usuario solo se llega si la ruta es @Publico() y además pide scopes: se niega.
    const concedidos = contexto.switchToHttp().getRequest<PeticionAutenticada>().usuario?.scopes;
    const faltantes = requeridos.filter((scope) => !concedidos?.includes(scope));
    if (faltantes.length === 0) return true;

    const detalle = `Missing required scopes: ${faltantes.join(' ')}`;
    throw new ErrorNegocio(403, CODIGO_SIN_EQUIVALENTE, detalle, {
      cabeceras: {
        'WWW-Authenticate': desafioBearer('insufficient_scope', detalle, requeridos),
      },
    });
  }
}
