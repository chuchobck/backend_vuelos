import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ScopesGuard } from '../../common/guards/scopes.guard';
import { VerificadorLocal } from './seguridad/verificador-local';
import { VerificadorToken } from './seguridad/verificador-token';

/**
 * Autenticación de toda petición: el verificador de tokens y los guards globales. Se carga
 * siempre, aparte de AuthModule (las rutas /auth del proveedor de identidad simulado). El orden
 * de los APP_GUARD es el de registro:
 *
 *   1. GuardLimitePeticiones (CommonModule, que AppModule importa antes que este módulo)
 *   2. JwtAuthGuard: JWT válido salvo en rutas @Publico()
 *   3. ScopesGuard: los scopes de @Scopes(...)
 */
@Module({
  providers: [
    { provide: VerificadorToken, useClass: VerificadorLocal },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: ScopesGuard },
  ],
})
export class AutenticacionModule {}
