import { Routes } from '@nestjs/core';
import { BusquedaModule } from './busqueda.module';

export const busquedaRoutes: Routes = [{ path: 'search', module: BusquedaModule }];
