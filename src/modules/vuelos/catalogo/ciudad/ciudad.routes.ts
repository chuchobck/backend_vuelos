import { Routes } from '@nestjs/core';
import { CiudadModule } from './ciudad.module';

export const ciudadRoutes: Routes = [{ path: 'cities', module: CiudadModule }];
