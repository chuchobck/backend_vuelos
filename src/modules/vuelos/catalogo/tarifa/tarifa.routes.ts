import { Routes } from '@nestjs/core';
import { TarifaModule } from './tarifa.module';

export const tarifaRoutes: Routes = [{ path: 'fares', module: TarifaModule }];
