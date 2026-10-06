import { Routes } from '@nestjs/core';
import { EquipajeModule } from './equipaje.module';

/** Cuelga de la reserva: /bookings/{bookingId}/baggage-options y /baggage. */
export const equipajeRoutes: Routes = [{ path: 'bookings/:bookingId', module: EquipajeModule }];
