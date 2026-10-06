import { Routes } from '@nestjs/core';
import { BoletoModule } from '../boleto/boleto.module';
import { ReservaModule } from './reserva.module';

/** Los boletos cuelgan de la reserva: /bookings/{bookingId}/tickets. */
export const reservaRoutes: Routes = [
  {
    path: 'bookings',
    module: ReservaModule,
    children: [{ path: ':bookingId/tickets', module: BoletoModule }],
  },
];
