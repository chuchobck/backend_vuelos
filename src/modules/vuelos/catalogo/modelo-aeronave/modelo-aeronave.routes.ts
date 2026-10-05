import { Routes } from '@nestjs/core';
import { ModeloAeronaveModule } from './modelo-aeronave.module';

export const modeloAeronaveRoutes: Routes = [
  { path: 'aircraft-models', module: ModeloAeronaveModule },
];
