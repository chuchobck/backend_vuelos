import { Routes } from '@nestjs/core';
import { AdministracionModule } from './administracion.module';
import { auditoriaRoutes } from './auditoria/auditoria.routes';
import { reservaAdminRoutes } from './reservas/reserva-admin.routes';

/** /flights/v1/admin/audit-log y /flights/v1/admin/bookings. */
export const administracionRoutes: Routes = [
  {
    path: 'admin',
    module: AdministracionModule,
    children: [...auditoriaRoutes, ...reservaAdminRoutes],
  },
];
