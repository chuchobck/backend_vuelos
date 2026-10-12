import { Routes } from '@nestjs/core';
import { ReservaAdminModule } from './reserva-admin.module';

export const reservaAdminRoutes: Routes = [{ path: 'bookings', module: ReservaAdminModule }];
