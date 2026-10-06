import { Routes } from '@nestjs/core';
import { CheckinModule } from './checkin.module';

/** Cuelga de la reserva: /bookings/{bookingId}/check-in. */
export const checkinRoutes: Routes = [{ path: 'bookings/:bookingId', module: CheckinModule }];
