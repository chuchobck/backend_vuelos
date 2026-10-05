import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RouterModule } from '@nestjs/core';

import { CommonModule } from './common/common.module';
import { validarEntorno } from './config/entorno';
import { PrismaModule } from './prisma/prisma.module';
import { rutas } from './routes/index.routes';
// import { AlojamientosModule } from './modules/alojamientos/alojamientos.module';
// import { AutosModule } from './modules/autos/autos.module';
// import { AtraccionesModule } from './modules/atracciones/atracciones.module';
import { VuelosModule } from './modules/vuelos/vuelos.module';

@Module({
  imports: [
    // Carga las variables de entorno y las valida; si falta una, la API no levanta
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validarEntorno,
    }),

    // Módulos Compartidos
    PrismaModule,
    CommonModule,

    // =========================================================================
    // ATENCIÓN ALUMNO: Descomenta solo el módulo que corresponde a tu grupo
    // =========================================================================
    // AlojamientosModule,
    // AutosModule,
    // AtraccionesModule,
    VuelosModule,

    // Tabla de rutas: src/routes/index.routes.ts
    RouterModule.register(rutas),
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
