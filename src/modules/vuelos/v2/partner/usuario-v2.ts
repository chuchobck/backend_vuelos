import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { IncomingHttpHeaders } from 'node:http';
import {
  PeticionAutenticada,
  UsuarioAutenticado,
} from '../../../../common/decorators/usuario-actual.decorator';
import { cuerpoInvalido } from '../../compartido/errores';

export const CABECERA_USUARIO = 'X-User-Id';
export const CABECERA_ROLES = 'X-User-Roles';

/** ck_reserva_cabecera_usuario_externo: un id opaco, sin espacios ni saltos de línea. */
const FORMATO_USUARIO = /^[A-Za-z0-9._:@|-]{1,100}$/;
/** Roles separados por coma, de 1 a 20. */
const FORMATO_ROLES = /^[A-Za-z0-9_-]{1,40}(,[A-Za-z0-9_-]{1,40}){0,19}$/;

/**
 * Quién llama a la fachada v2 (contrato v2, §5):
 *
 * - Una persona (token sin `client_id`): como en v1. X-User-Id y X-User-Roles se IGNORAN: nadie
 *   se hace pasar por otro usuario mandando una cabecera.
 * - Un partner (token con `client_id`, client_credentials de identity, solo con
 *   AUTH_MODE=external): el dueño de lo que crea es su `sub`, y X-User-Id (si llega) es el
 *   usuario final de Booking: se guarda en la reserva y limita lo que el partner ve y opera a las
 *   reservas de ese usuario.
 */
export interface UsuarioV2 extends UsuarioAutenticado {
  /** X-User-Id: solo con un token de partner (`clienteId`). */
  usuarioExterno?: string;
  /** X-User-Roles: solo con un token de partner. Hoy no decide nada (no hay operaciones OPS). */
  rolesExternos?: string[];
}

/**
 * Arma el UsuarioV2 del usuario que ya verificó JwtAuthGuard. Con un partner, una X-User-Id o
 * X-User-Roles con un formato que no se acepta es 400 (el error nombra la cabecera, no el valor):
 * seguir sin ella dejaría ver al partner las reservas de todos sus usuarios.
 */
export function resolverUsuarioV2(
  usuario: UsuarioAutenticado,
  cabeceras: IncomingHttpHeaders,
): UsuarioV2 {
  if (usuario.clienteId === undefined) return { ...usuario };

  const resultado: UsuarioV2 = { ...usuario };
  const externo = cabeceras['x-user-id'];
  if (externo !== undefined) {
    if (typeof externo !== 'string' || !FORMATO_USUARIO.test(externo)) {
      throw cuerpoInvalido(CABECERA_USUARIO, 'must be 1 to 100 letters, digits or . _ : @ | -');
    }
    resultado.usuarioExterno = externo;
  }
  const roles = cabeceras['x-user-roles'];
  if (roles !== undefined) {
    if (typeof roles !== 'string' || !FORMATO_ROLES.test(roles)) {
      throw cuerpoInvalido(CABECERA_ROLES, 'must be a comma separated list of role codes');
    }
    resultado.rolesExternos = roles.split(',');
  }
  return resultado;
}

/**
 * El UsuarioV2 de la petición, en un parámetro del controller (solo rutas con token):
 *
 *   detalle(@UsuarioFachada() usuario: UsuarioV2) {}
 */
export const UsuarioFachada = createParamDecorator(
  (_dato: unknown, contexto: ExecutionContext): UsuarioV2 => {
    const peticion = contexto.switchToHttp().getRequest<PeticionAutenticada>();
    return resolverUsuarioV2(peticion.usuario!, peticion.headers);
  },
);
