import { Routes } from '@nestjs/core';
import { KioskoModule } from './kiosko.module';

/** /flights/v1/kiosk/lookup y /flights/v1/kiosk/bookings/{bookingId}/... */
export const kioskoRoutes: Routes = [{ path: 'kiosk', module: KioskoModule }];
