import { Routes } from '@nestjs/core';
import { CancelacionModule } from './cancelacion.module';

/** Cuelga de la reserva: /bookings/{bookingId}/cancellation-quote y /cancel. */
export const cancelacionRoutes: Routes = [
  { path: 'bookings/:bookingId', module: CancelacionModule },
];
