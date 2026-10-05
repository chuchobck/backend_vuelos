import { Routes } from '@nestjs/core';
import { FamiliaTarifaModule } from './familia-tarifa.module';

export const familiaTarifaRoutes: Routes = [{ path: 'fare-families', module: FamiliaTarifaModule }];
