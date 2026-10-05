import { TokenRespuestaDto } from './dto/token-respuesta.dto';
import { UsuarioRespuestaDto } from './dto/usuario-respuesta.dto';
import { UsuarioConRoles } from './auth.repository';
import { Scope, scopesDeRoles } from './scopes';

/** Fila en español → JSON de la API. El hash de la contraseña nunca sale de aquí. */
export function aUsuarioRespuesta(usuario: UsuarioConRoles): UsuarioRespuestaDto {
  return {
    id: usuario.id,
    email: usuario.correo,
    roles: usuario.roles,
    scopes: scopesDeRoles(usuario.roles),
    createdAt: usuario.fechaCreacion.toISOString(),
  };
}

export function aTokenRespuesta(sesion: {
  tokenAcceso: string;
  expiraEnSegundos: number;
  tokenRefresco: string;
  scopes: readonly Scope[];
}): TokenRespuestaDto {
  return {
    access_token: sesion.tokenAcceso,
    token_type: 'Bearer',
    expires_in: sesion.expiraEnSegundos,
    refresh_token: sesion.tokenRefresco,
    scope: sesion.scopes.join(' '),
  };
}
