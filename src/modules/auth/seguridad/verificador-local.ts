import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isUUID } from 'class-validator';
import * as jwt from 'jsonwebtoken';
import { ALGORITMO_LOCAL, EMISOR_POR_DEFECTO } from './token-acceso.service';
import { IdentidadToken, TokenInvalidoError, VerificadorToken } from './verificador-token';

/**
 * Verifica los tokens que emite la propia API (TokenAccesoService): HS256 con JWT_SECRET, el
 * `iss` y el `aud` de JWT_ISSUER y JWT_AUDIENCE (quinde-vuelos-api si no están).
 */
@Injectable()
export class VerificadorLocal extends VerificadorToken {
  private readonly clave: string;
  private readonly emisor: string;
  private readonly audiencia: string;

  constructor(config: ConfigService) {
    super();
    this.clave = config.getOrThrow<string>('JWT_SECRET');
    this.emisor = config.get<string>('JWT_ISSUER') || EMISOR_POR_DEFECTO;
    this.audiencia = config.get<string>('JWT_AUDIENCE') || EMISOR_POR_DEFECTO;
  }

  /** Comprueba firma, algoritmo, `iss`, `aud`, `exp` y la forma de los claims. */
  verificar(token: string): Promise<IdentidadToken> {
    let claims: string | jwt.JwtPayload;
    try {
      claims = jwt.verify(token, this.clave, {
        algorithms: [ALGORITMO_LOCAL],
        issuer: this.emisor,
        audience: this.audiencia,
      });
    } catch (error) {
      return Promise.reject(
        new TokenInvalidoError(error instanceof jwt.TokenExpiredError ? 'expirado' : 'invalido'),
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
      return Promise.reject(new TokenInvalidoError('invalido'));
    }

    return Promise.resolve({
      sub: claims.sub as string,
      scopes: claims.scope.split(' ').filter((scope) => scope !== ''),
      jti: claims.jti,
    });
  }
}
