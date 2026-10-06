import { Routes } from '@nestjs/core';
import { ReservaModule } from './reserva.module';

export const reservaRoutes: Routes = [{ path: 'bookings', module: ReservaModule }];
