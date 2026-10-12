import { UsuarioConRoles } from '../auth.repository';
import { AdministradorRespuestaDto, ListaAdministradoresDto } from './dto/administrador.dto';
import { FilaAdministrador } from './administradores.repository';

/** Nunca lleva el hash de la contraseña: ni siquiera pasa por estos tipos. */
export function aAdministrador(
  fila: Pick<FilaAdministrador, 'id' | 'correo' | 'activo' | 'fechaCreacion'>,
): AdministradorRespuestaDto {
  return {
    id: fila.id,
    email: fila.correo,
    createdAt: fila.fechaCreacion.toISOString(),
    active: fila.activo,
  };
}

export const aAdministradorCreado = (usuario: UsuarioConRoles): AdministradorRespuestaDto =>
  aAdministrador({
    id: usuario.id,
    correo: usuario.correo,
    activo: usuario.activo,
    fechaCreacion: usuario.fechaCreacion,
  });

export function aListaAdministradores(pagina: {
  filas: FilaAdministrador[];
  nextCursor?: string;
}): ListaAdministradoresDto {
  const items = pagina.filas.map(aAdministrador);
  return pagina.nextCursor === undefined ? { items } : { items, nextCursor: pagina.nextCursor };
}
