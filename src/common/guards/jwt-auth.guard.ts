import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { fijarUsuario } from '../contexto/contexto-peticion';
import { ES_PUBLICO } from '../decorators/publico.decorator';
import { PeticionAutenticada } from '../decorators/usuario-actual.decorator';
import { desafioBearer, noAutenticado } from '../../modules/auth/errores-auth';
import {
  TokenAccesoService,
  TokenInvalidoError,
} from '../../modules/auth/seguridad/token-acceso.service';

/** `Bearer <token>`; el esquema no distingue mayúsculas (RFC 7235). */
const CABECERA_BEARER = /^Bearer[ ]+([A-Za-z0-9._~+/-]+=*)[ ]*$/i;

/**
 * Guard global: toda ruta exige un JWT de acceso válido salvo las marcadas con @Publico().
 * Corre después del límite de peticiones (un 401 también cuenta) y antes de ScopesGuard.
 *
 * - Sin cabecera Authorization, o con otro esquema: 401 con `WWW-Authenticate: Bearer realm=...`
 * - Token vencido, mal firmado, de otro emisor o audiencia: 401 con `error="invalid_token"`
 *
 * Con un token válido deja el usuario en la petición (@UsuarioActual) y en el contexto, para
 * que la auditoría registre su `sub`. El token nunca va al log ni a la respuesta.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenAccesoService,
  ) {}

  canActivate(contexto: ExecutionContext): boolean {
    const esPublico = this.reflector.getAllAndOverride<boolean>(ES_PUBLICO, [
      contexto.getHandler(),
      contexto.getClass(),
    ]);
    if (esPublico) return true;

    const peticion = contexto.switchToHttp().getRequest<PeticionAutenticada>();
    const coincidencia = CABECERA_BEARER.exec(peticion.headers.authorization ?? '');
    if (!coincidencia) throw noAutenticado('A bearer access token is required');

    try {
      const identidad = this.tokens.verificar(coincidencia[1]);
      peticion.usuario = { id: identidad.sub, scopes: identidad.scopes, idToken: identidad.jti };
      fijarUsuario(identidad.sub);
      return true;
    } catch (error) {
      if (!(error instanceof TokenInvalidoError)) throw error;
      throw noAutenticado(error.message, desafioBearer('invalid_token', error.message));
    }
  }
}
