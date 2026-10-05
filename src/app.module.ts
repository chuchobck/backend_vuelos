import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { CommonModule } from './common/common.module';
// import { AlojamientosModule } from './modules/alojamientos/alojamientos.module';
// import { AutosModule } from './modules/autos/autos.module';
// import { AtraccionesModule } from './modules/atracciones/atracciones.module';
import { VuelosModule } from './modules/vuelos/vuelos.module';

@Module({
  imports: [
    // Carga de variables de entorno globales
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    // Módulos Compartidos
    CommonModule,

    // =========================================================================
    // ATENCIÓN ALUMNO: Descomenta solo el módulo que corresponde a tu grupo
    // =========================================================================
    // AlojamientosModule,
    // AutosModule,
    // AtraccionesModule,
    VuelosModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
