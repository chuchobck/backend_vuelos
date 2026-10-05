import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ScopesGuard } from '../../common/guards/scopes.guard';
import { AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { ContrasenaService } from './seguridad/contrasena.service';
import { TokenAccesoService } from './seguridad/token-acceso.service';

/**
 * Proveedor de identidad simulado (RDA1): registro, login y tokens. También registra los
 * guards globales de autenticación; el orden de los APP_GUARD es el de registro:
 *
 *   1. GuardLimitePeticiones (CommonModule, que AppModule importa antes que este módulo)
 *   2. JwtAuthGuard: JWT válido salvo en rutas @Publico()
 *   3. ScopesGuard: los scopes de @Scopes(...)
 */
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthRepository,
    ContrasenaService,
    TokenAccesoService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: ScopesGuard },
  ],
  exports: [TokenAccesoService],
})
export class AuthModule {}
