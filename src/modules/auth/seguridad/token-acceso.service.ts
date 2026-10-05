import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isUUID } from 'class-validator';
import * as jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';

/** Vigencia del token de acceso. Corta a propósito: no se puede revocar antes de que venza. */
export const VIGENCIA_ACCESO_SEGUNDOS = 15 * 60;

/** `iss` y `aud` cuando JWT_ISSUER y JWT_AUDIENCE no están definidas. */
export const EMISOR_POR_DEFECTO = 'quinde-vuelos-api';

/** Único algoritmo que se firma y se acepta: un token con `alg: none` o RS256 se rechaza. */
const ALGORITMO = 'HS256';

export interface TokenAccesoEmitido {
  token: string;
  expiraEnSegundos: number;
}

/** Lo que el guard saca de un token válido. */
export interface IdentidadToken {
  /** usuario.id; es el `id_propietario` de retenciones, reservas y webhooks. */
  sub: string;
  scopes: string[];
  jti: string;
}

export type MotivoTokenInvalido = 'expirado' | 'invalido';

/** El token no sirve. El guard lo convierte en 401; el motivo no lleva el token. */
export class TokenInvalidoError extends Error {
  constructor(readonly motivo: MotivoTokenInvalido) {
    super(motivo === 'expirado' ? 'The access token expired' : 'The access token is invalid');
    this.name = 'TokenInvalidoError';
  }
}

/**
 * Tokens de acceso JWT firmados con HS256 y JWT_SECRET. Llevan `sub`, `scope` (permisos
 * separados por espacio, como RFC 8693 y RFC 9068), `iss`, `aud`, `jti`, `iat` y `exp`.
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
      algorithm: ALGORITMO,
      expiresIn: VIGENCIA_ACCESO_SEGUNDOS,
      issuer: this.emisor,
      audience: this.audiencia,
      subject: sub,
      jwtid: randomUUID(),
    });
    return { token, expiraEnSegundos: VIGENCIA_ACCESO_SEGUNDOS };
  }

  /** Comprueba firma, algoritmo, `iss`, `aud`, `exp` y la forma de los claims. */
  verificar(token: string): IdentidadToken {
    let claims: string | jwt.JwtPayload;
    try {
      claims = jwt.verify(token, this.clave, {
        algorithms: [ALGORITMO],
        issuer: this.emisor,
        audience: this.audiencia,
      });
    } catch (error) {
      throw new TokenInvalidoError(
        error instanceof jwt.TokenExpiredError ? 'expirado' : 'invalido',
      );
    }

    // jsonwebtoken acepta un token sin `exp`; la API no: todo token de acceso vence.
    if (
      typeof claims !== 'object' ||
      !isUUID(claims.sub) ||
      typeof claims.scope !== 'string' ||
      typeof claims.jti !== 'string' ||
      typeof claims.exp !== 'number' ||
      typeof claims.iat !== 'number'
    ) {
      throw new TokenInvalidoError('invalido');
    }

    return {
      sub: claims.sub as string,
      scopes: claims.scope.split(' ').filter((scope) => scope !== ''),
      jti: claims.jti,
    };
  }
}
