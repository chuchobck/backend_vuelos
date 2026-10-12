import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CODIGO_SIN_EQUIVALENTE } from '../../../common/errores/codigo-error';
import { ErrorNegocio } from '../../../common/errores/error-negocio';
import { cursorInvalido, noEncontrado } from '../../vuelos/catalogo/base/errores-catalogo';
import {
  codificarCursor,
  decodificarCursor,
  LIMITE_POR_DEFECTO,
} from '../../vuelos/catalogo/base/paginacion';
import { esUuid } from '../../../common/pipes/formatos';
import { UsuarioConRoles } from '../auth.repository';
import { AuthRepository } from '../auth.repository';
import { ROL_ADMINISTRADOR } from '../scopes';
import { ContrasenaService } from '../seguridad/contrasena.service';
import { ConsultaAdministradoresDto, CrearAdministradorDto } from './dto/administrador.dto';
import { AdministradoresRepository, FilaAdministrador } from './administradores.repository';

/**
 * Altas, lista y bajas de administradores. No tiene lógica de seguridad propia: el hash es el
 * de ContrasenaService (mismos parámetros argon2id que el registro) y el alta es la de
 * AuthRepository, con el rol fijado aquí.
 */
@Injectable()
export class AdministradoresService {
  constructor(
    private readonly auth: AuthRepository,
    private readonly contrasenas: ContrasenaService,
    private readonly repositorio: AdministradoresRepository,
  ) {}

  /**
   * Crea un usuario con el rol administrador. El actor de la auditoría es el administrador
   * que llama (su `sub` ya está en el contexto). Un correo repetido falla por
   * uq_usuario_correo y el filtro de errores lo responde como 409.
   */
  async crear(dto: CrearAdministradorDto): Promise<UsuarioConRoles> {
    const hash = await this.contrasenas.hashear(dto.password);
    return this.auth.crearUsuario(randomUUID(), dto.email, hash, ROL_ADMINISTRADOR);
  }

  async listar(
    consulta: ConsultaAdministradoresDto,
  ): Promise<{ filas: FilaAdministrador[]; nextCursor?: string }> {
    const limite = consulta.limit ?? LIMITE_POR_DEFECTO;
    const filas = await this.repositorio.listar({
      incluirInactivos: consulta.includeInactive ?? false,
      despuesDe: consulta.cursor ? leerCursor(consulta.cursor) : undefined,
      limite,
    });
    if (filas.length <= limite) return { filas };
    const ultima = filas[limite - 1];
    return {
      filas: filas.slice(0, limite),
      nextCursor: codificarCursor(`${ultima.fechaCreacion.toISOString()}|${ultima.id}`),
    };
  }

  /**
   * Baja lógica. 404 si no existe o no es administrador; 409 si es el propio solicitante o el
   * último administrador activo; repetirla sobre quien ya estaba de baja responde igual (204).
   */
  async darDeBaja(id: string, idSolicitante: string): Promise<void> {
    const resultado = await this.repositorio.baja(id, idSolicitante);
    if (resultado === 'no-existe') throw noEncontrado('Administrator', id);
    if (resultado === 'es-el-mismo') {
      throw new ErrorNegocio(
        409,
        CODIGO_SIN_EQUIVALENTE,
        'You cannot deactivate your own account; ask another administrator',
      );
    }
    if (resultado === 'es-el-ultimo') {
      throw new ErrorNegocio(
        409,
        CODIGO_SIN_EQUIVALENTE,
        'The last active administrator cannot be deactivated',
      );
    }
  }
}

/** El cursor de la lista: `creación|id`. Cualquier otro texto es 400. */
function leerCursor(cursor: string): { creada: Date; id: string } {
  const [creada, id, ...resto] = (decodificarCursor(cursor) ?? '').split('|');
  const fecha = new Date(creada);
  if (resto.length > 0 || Number.isNaN(fecha.getTime()) || !esUuid(id)) throw cursorInvalido();
  return { creada: fecha, id };
}
