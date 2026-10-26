import { Module } from '@nestjs/common';
import { ConditionalModule, ConfigModule } from '@nestjs/config';
import { RouterModule } from '@nestjs/core';

import { CommonModule } from './common/common.module';
import { validarEntorno } from './config/entorno';
import { ObservabilidadModule } from './observabilidad/observabilidad.module';
import { PrismaModule } from './prisma/prisma.module';
import { rutas } from './routes/index.routes';
import { AdministradoresModule } from './modules/auth/administradores/administradores.module';
import { AuthModule } from './modules/auth/auth.module';
import { AutenticacionModule } from './modules/auth/autenticacion.module';
import { SaludModule } from './modules/salud/salud.module';
import { FachadaV2Module } from './modules/vuelos/v2/v2.module';
import { VuelosModule } from './modules/vuelos/vuelos.module';

/** AUTH_MODE sin definir o local (entorno.ts ya validó el valor). */
function esModoLocal(entorno: NodeJS.ProcessEnv): boolean {
  return entorno.AUTH_MODE !== 'external';
}

@Module({
  imports: [
    // Carga las variables de entorno y las valida; si falta una, la API no levanta
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validarEntorno,
    }),

    // Módulos Compartidos. CommonModule va antes que AutenticacionModule: así el límite de
    // peticiones es el primer guard global y corre antes que el de JWT (ver autenticacion.module.ts).
    ObservabilidadModule,
    PrismaModule,
    CommonModule,
    SaludModule,
    AutenticacionModule,
    // El proveedor de identidad simulado (/auth) y /admin/users solo con AUTH_MODE=local. Con
    // external los tokens los emite el servicio de identidad: esas rutas no existen (404).
    ConditionalModule.registerWhen(AuthModule, esModoLocal, { debug: false }),
    ConditionalModule.registerWhen(AdministradoresModule, esModoLocal, { debug: false }),

    VuelosModule,
    // La fachada del contrato v2 (/api/v2/vuelos), sobre los services de VuelosModule
    FachadaV2Module,

    // Tabla de rutas: src/routes/index.routes.ts
    RouterModule.register(rutas),
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
