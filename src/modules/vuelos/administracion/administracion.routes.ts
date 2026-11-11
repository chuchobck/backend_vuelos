import { Routes } from '@nestjs/core';
import { AdministracionModule } from './administracion.module';
import { auditoriaRoutes } from './auditoria/auditoria.routes';
import { embarqueRoutes } from './embarque/embarque.routes';
import { reservaAdminRoutes } from './reservas/reserva-admin.routes';

/**
 * /flights/v1/admin/audit-log, /flights/v1/admin/bookings y
 * /flights/v1/admin/departures/{departureId}/boarding.
 */
export const administracionRoutes: Routes = [
  {
    path: 'admin',
    module: AdministracionModule,
    children: [...auditoriaRoutes, ...reservaAdminRoutes, ...embarqueRoutes],
  },
];
