import { Routes } from '@nestjs/core';
import { VueloModule } from './vuelo.module';

export const vueloRoutes: Routes = [{ path: 'flights', module: VueloModule }];
