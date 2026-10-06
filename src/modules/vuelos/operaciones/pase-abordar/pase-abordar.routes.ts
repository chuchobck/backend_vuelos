import { Routes } from '@nestjs/core';
import { PaseAbordarModule } from './pase-abordar.module';

/** Cuelga de la reserva: /bookings/{bookingId}/boarding-passes. */
export const paseAbordarRoutes: Routes = [
  { path: 'bookings/:bookingId', module: PaseAbordarModule },
];
