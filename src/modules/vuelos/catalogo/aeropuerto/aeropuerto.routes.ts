import { Routes } from '@nestjs/core';
import { AeropuertoModule } from './aeropuerto.module';

export const aeropuertoRoutes: Routes = [{ path: 'airports', module: AeropuertoModule }];
