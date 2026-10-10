import { Routes } from '@nestjs/core';
import { AdministradoresModule } from './administradores.module';

export const administradoresRoutes: Routes = [
  { path: 'admin/users', module: AdministradoresModule },
];
