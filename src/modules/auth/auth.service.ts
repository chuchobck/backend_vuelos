import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { fijarUsuario } from '../../common/contexto/contexto-peticion';
import { aTokenRespuesta } from './auth.mapper';
import { AuthRepository, TokenRefrescoGuardado, UsuarioConRoles } from './auth.repository';
import { LoginDto, RegistroDto } from './dto/credenciales.dto';
import { TokenRespuestaDto } from './dto/token-respuesta.dto';
import { credencialesInvalidas, refrescoInvalido } from './errores-auth';
import { ROL_DEL_REGISTRO, scopesDeRoles } from './scopes';
import { ContrasenaService } from './seguridad/contrasena.service';
import { TokenAccesoService } from './seguridad/token-acceso.service';
import {
  generarTokenRefresco,
  hashearTokenRefresco,
  tieneFormatoDeTokenRefresco,
  VIGENCIA_REFRESCO_SEGUNDOS,
} from './seguridad/token-refresco';

/**
 * Reglas del proveedor de identidad simulado. Ningún mensaje de log ni de error lleva una
 * contraseña ni un token: a lo sumo el id del usuario o de la familia de tokens.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly repositorio: AuthRepository,
    private readonly contrasenas: ContrasenaService,
    private readonly tokensAcceso: TokenAccesoService,
  ) {}

  /** Crea una cuenta con el rol de cliente. Un correo ya registrado responde 409. */
  async registrar(dto: RegistroDto): Promise<UsuarioConRoles> {
    // El id se genera aquí para que la auditoría registre al propio usuario como autor del alta
    const id = randomUUID();
    fijarUsuario(id);
    const hash = await this.contrasenas.hashear(dto.password);
    return this.repositorio.crearUsuario(id, dto.email, hash, ROL_DEL_REGISTRO);
  }

  /**
   * Correo inexistente, contraseña errónea y cuenta inactiva responden igual y tardan lo
   * mismo: siempre se corre argon2, contra el hash ficticio si el correo no existe.
   */
  async iniciarSesion(dto: LoginDto): Promise<TokenRespuestaDto> {
    const usuario = await this.repositorio.buscarPorCorreo(dto.email);
    if (!usuario) {
      await this.contrasenas.verificarSinUsuario(dto.password);
      throw credencialesInvalidas();
    }
    const valida = await this.contrasenas.verificar(usuario.hashContrasena, dto.password);
    if (!valida || !usuario.activo) throw credencialesInvalidas();

    fijarUsuario(usuario.id);
    if (this.contrasenas.necesitaRehash(usuario.hashContrasena)) {
      await this.repositorio.actualizarHashContrasena(
        usuario.id,
        await this.contrasenas.hashear(dto.password),
      );
    }

    // Cada login abre una familia nueva de tokens de refresco
    const refresco = generarTokenRefresco();
    await this.repositorio.crearTokenRefresco({
      usuarioId: usuario.id,
      idFamilia: randomUUID(),
      hash: refresco.hash,
      fechaExpiracion: vencimientoRefresco(),
    });
    return this.respuesta(usuario, refresco.token);
  }

  /**
   * Rotación: el token usado queda marcado como reemplazado y se entrega uno nuevo de la
   * misma familia. Si llega uno que ya fue reemplazado, alguien más lo tiene: se revoca la
   * familia completa y el dueño tiene que volver a iniciar sesión.
   */
  async refrescar(token: string): Promise<TokenRespuestaDto> {
    if (!tieneFormatoDeTokenRefresco(token)) throw refrescoInvalido();

    const guardado = await this.repositorio.buscarTokenRefresco(hashearTokenRefresco(token));
    if (!guardado || guardado.revocado || guardado.fechaExpiracion <= new Date()) {
      throw refrescoInvalido();
    }
    if (guardado.reemplazado) {
      await this.revocarPorReutilizacion(guardado);
      throw refrescoInvalido();
    }
    if (!guardado.usuario.activo) {
      await this.repositorio.revocarFamilia(guardado.idFamilia, 'USUARIO_INACTIVO');
      throw refrescoInvalido();
    }

    fijarUsuario(guardado.usuario.id);
    const nuevo = generarTokenRefresco();
    const rotado = await this.repositorio.rotarTokenRefresco(guardado.id, {
      usuarioId: guardado.usuario.id,
      idFamilia: guardado.idFamilia,
      hash: nuevo.hash,
      fechaExpiracion: vencimientoRefresco(),
    });
    // Otro refresh con el mismo token ganó la carrera: es una reutilización
    if (!rotado) {
      await this.revocarPorReutilizacion(guardado);
      throw refrescoInvalido();
    }
    return this.respuesta(guardado.usuario, nuevo.token);
  }

  private async revocarPorReutilizacion(guardado: TokenRefrescoGuardado): Promise<void> {
    const revocados = await this.repositorio.revocarFamilia(guardado.idFamilia, 'REUTILIZACION');
    this.logger.warn(
      `Reutilización de un token de refresco ya rotado: se revocó la familia ${guardado.idFamilia} ` +
        `(${revocados} tokens sin revocar) del usuario ${guardado.usuario.id}`,
    );
  }

  /** Los scopes se recalculan en cada login y refresh: un cambio de rol entra en el siguiente. */
  private respuesta(usuario: UsuarioConRoles, tokenRefresco: string): TokenRespuestaDto {
    const scopes = scopesDeRoles(usuario.roles);
    const acceso = this.tokensAcceso.emitir(usuario.id, scopes);
    return aTokenRespuesta({
      tokenAcceso: acceso.token,
      expiraEnSegundos: acceso.expiraEnSegundos,
      tokenRefresco,
      scopes,
    });
  }
}

function vencimientoRefresco(): Date {
  return new Date(Date.now() + VIGENCIA_REFRESCO_SEGUNDOS * 1000);
}
