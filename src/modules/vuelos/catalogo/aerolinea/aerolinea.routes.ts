import { Routes } from '@nestjs/core';
import { AerolineaModule } from './aerolinea.module';

export const aerolineaRoutes: Routes = [{ path: 'airlines', module: AerolineaModule }];
