import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ScopesGuard } from '../../common/guards/scopes.guard';
import { Reloj } from '../../common/reloj';
import { configuracionExterna, modoAuth } from '../../config/autenticacion';
import { ClavesJwks } from './seguridad/claves-jwks';
import { VerificadorJwks } from './seguridad/verificador-jwks';
import { VerificadorLocal } from './seguridad/verificador-local';
import { VerificadorToken } from './seguridad/verificador-token';

/**
 * Elige el verificador según AUTH_MODE (src/config/autenticacion.ts) y lo deja en el log al
 * arrancar, como los procesos periódicos.
 */
function crearVerificador(config: ConfigService, reloj: Reloj): VerificadorToken {
  const logger = new Logger('Autenticacion');
  if (modoAuth(config) === 'local') {
    logger.log('AUTH_MODE=local: la API emite y verifica sus propios tokens (HS256)');
    return new VerificadorLocal(config);
  }
  const externa = configuracionExterna(config);
  logger.log(`AUTH_MODE=external: tokens RS256 de ${externa.emisor}, claves de ${externa.urlJwks}`);
  return new VerificadorJwks(new ClavesJwks(externa.urlJwks, reloj), externa, reloj);
}

/**
 * Autenticación de toda petición: el verificador de tokens (local o externo, según AUTH_MODE) y
 * los guards globales. Se carga siempre, aparte de AuthModule (las rutas /auth del proveedor de
 * identidad simulado). El orden de los APP_GUARD es el de registro:
 *
 *   1. GuardLimitePeticiones (CommonModule, que AppModule importa antes que este módulo)
 *   2. JwtAuthGuard: JWT válido salvo en rutas @Publico()
 *   3. ScopesGuard: los scopes de @Scopes(...)
 */
@Module({
  providers: [
    { provide: VerificadorToken, inject: [ConfigService, Reloj], useFactory: crearVerificador },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: ScopesGuard },
  ],
})
export class AutenticacionModule {}
