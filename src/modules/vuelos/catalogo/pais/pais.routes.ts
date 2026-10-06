import { Routes } from '@nestjs/core';
import { PaisModule } from './pais.module';

export const paisRoutes: Routes = [{ path: 'countries', module: PaisModule }];
