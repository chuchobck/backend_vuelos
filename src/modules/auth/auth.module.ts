import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { ContrasenaService } from './seguridad/contrasena.service';
import { TokenAccesoService } from './seguridad/token-acceso.service';

/**
 * Proveedor de identidad simulado (RDA1): registro, login y tokens (/auth). Los guards globales
 * y la verificación de los tokens están en AutenticacionModule.
 */
@Module({
  controllers: [AuthController],
  providers: [AuthService, AuthRepository, ContrasenaService, TokenAccesoService],
  exports: [TokenAccesoService, AuthRepository, ContrasenaService],
})
export class AuthModule {}
