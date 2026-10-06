import { Routes } from '@nestjs/core';
import { VueloProgramadoModule } from './vuelo-programado.module';

export const vueloProgramadoRoutes: Routes = [
  { path: 'departures', module: VueloProgramadoModule },
];
