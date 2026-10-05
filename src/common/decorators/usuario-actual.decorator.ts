import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

/** Quién hace la petición, según el JWT que JwtAuthGuard ya verificó. */
export interface UsuarioAutenticado {
  /** `sub` del token: usuario.id y el `id_propietario` de retenciones, reservas y webhooks. */
  id: string;
  scopes: string[];
  /** `jti` del token de acceso. */
  idToken: string;
}

export type PeticionAutenticada = Request & { usuario?: UsuarioAutenticado };

/**
 * Inyecta el usuario autenticado en un parámetro del controller:
 *
 *   @Get('me')
 *   perfil(@UsuarioActual() usuario: UsuarioAutenticado) {}
 *
 * En una ruta @Publico() vale undefined.
 */
export const UsuarioActual = createParamDecorator(
  (_dato: unknown, contexto: ExecutionContext): UsuarioAutenticado | undefined =>
    contexto.switchToHttp().getRequest<PeticionAutenticada>().usuario,
);
