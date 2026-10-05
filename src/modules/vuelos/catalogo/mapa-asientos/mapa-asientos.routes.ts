import { Routes } from '@nestjs/core';
import { MapaAsientosModule } from './mapa-asientos.module';

export const mapaAsientosRoutes: Routes = [{ path: 'seat-maps', module: MapaAsientosModule }];
