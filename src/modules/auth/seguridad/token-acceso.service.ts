import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';

/** Vigencia del token de acceso. Corta a propósito: no se puede revocar antes de que venza. */
export const VIGENCIA_ACCESO_SEGUNDOS = 15 * 60;

/** `iss` y `aud` cuando JWT_ISSUER y JWT_AUDIENCE no están definidas. */
export const EMISOR_POR_DEFECTO = 'quinde-vuelos-api';

/**
 * Único algoritmo que se firma y se acepta en AUTH_MODE=local: un token con `alg: none` o RS256
 * se rechaza (VerificadorLocal).
 */
export const ALGORITMO_LOCAL = 'HS256';

export interface TokenAccesoEmitido {
  token: string;
  expiraEnSegundos: number;
}

/**
 * Emite los tokens de acceso del proveedor de identidad simulado (AUTH_MODE=local): JWT firmados
 * con HS256 y JWT_SECRET, con `sub`, `scope` (permisos separados por espacio, como RFC 8693 y
 * RFC 9068), `iss`, `aud`, `jti`, `iat` y `exp`. Los verifica VerificadorLocal.
 */
@Injectable()
export class TokenAccesoService {
  private readonly clave: string;
  private readonly emisor: string;
  private readonly audiencia: string;

  constructor(config: ConfigService) {
    this.clave = config.getOrThrow<string>('JWT_SECRET');
    this.emisor = config.get<string>('JWT_ISSUER') || EMISOR_POR_DEFECTO;
    this.audiencia = config.get<string>('JWT_AUDIENCE') || EMISOR_POR_DEFECTO;
  }

  emitir(sub: string, scopes: readonly string[]): TokenAccesoEmitido {
    const token = jwt.sign({ scope: scopes.join(' ') }, this.clave, {
      algorithm: ALGORITMO_LOCAL,
      expiresIn: VIGENCIA_ACCESO_SEGUNDOS,
      issuer: this.emisor,
      audience: this.audiencia,
      subject: sub,
      jwtid: randomUUID(),
    });
    return { token, expiraEnSegundos: VIGENCIA_ACCESO_SEGUNDOS };
  }
}
