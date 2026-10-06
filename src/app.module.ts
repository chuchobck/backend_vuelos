import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RouterModule } from '@nestjs/core';

import { CommonModule } from './common/common.module';
import { validarEntorno } from './config/entorno';
import { PrismaModule } from './prisma/prisma.module';
import { rutas } from './routes/index.routes';
import { AuthModule } from './modules/auth/auth.module';
import { SaludModule } from './modules/salud/salud.module';
import { VuelosModule } from './modules/vuelos/vuelos.module';

@Module({
  imports: [
    // Carga las variables de entorno y las valida; si falta una, la API no levanta
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validarEntorno,
    }),

    // Módulos Compartidos. CommonModule va antes que AuthModule: así el límite de peticiones
    // es el primer guard global y corre antes que el de JWT (ver auth.module.ts).
    PrismaModule,
    CommonModule,
    SaludModule,
    AuthModule,

    VuelosModule,

    // Tabla de rutas: src/routes/index.routes.ts
    RouterModule.register(rutas),
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
