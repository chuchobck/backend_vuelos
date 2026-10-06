import { Routes } from '@nestjs/core';
import { CambioFechaModule } from './cambio-fecha.module';

/** Cuelga de la reserva: /bookings/{bookingId}/date-change/search y /date-change. */
export const cambioFechaRoutes: Routes = [
  { path: 'bookings/:bookingId', module: CambioFechaModule },
];
