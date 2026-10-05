import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { PARAMETROS_ARGON2 } from '../../../config/argon2';

const OPCIONES: argon2.HashOptions = { type: argon2.argon2id, ...PARAMETROS_ARGON2 };

/** Hash y verificación de contraseñas con argon2id. La contraseña nunca se guarda ni se registra. */
@Injectable()
export class ContrasenaService {
  /**
   * Hash de una contraseña al azar, calculado una vez al arrancar. Cuando el correo no existe
   * se verifica contra él: el login tarda lo mismo que con un correo real y no se puede saber
   * por el tiempo de respuesta qué correos tienen cuenta.
   */
  private readonly hashFicticio = argon2.hash(randomBytes(32).toString('base64url'), OPCIONES);

  hashear(contrasena: string): Promise<string> {
    return argon2.hash(contrasena, OPCIONES);
  }

  /** false también si el hash está dañado: un hash ilegible nunca da acceso. */
  async verificar(hash: string, contrasena: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, contrasena);
    } catch {
      return false;
    }
  }

  /** Mismo trabajo que `verificar`, contra el hash ficticio. Siempre devuelve false. */
  async verificarSinUsuario(contrasena: string): Promise<false> {
    await this.verificar(await this.hashFicticio, contrasena);
    return false;
  }

  /** true si el hash se calculó con otros parámetros y conviene recalcularlo. */
  necesitaRehash(hash: string): boolean {
    try {
      return argon2.needsRehash(hash, OPCIONES);
    } catch {
      return false;
    }
  }
}
