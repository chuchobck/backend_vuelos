import { Module } from '@nestjs/common';
import { AuditoriaModule } from './auditoria/auditoria.module';
import { EmbarqueModule } from './embarque/embarque.module';
import { ReservaAdminModule } from './reservas/reserva-admin.module';

/**
 * Administración fuera del contrato (solo `flights:admin`), aparte del catálogo: el registro de
 * auditoría, las reservas de todos los clientes y el embarque de una salida. Sus rutas cuelgan de /flights/v1/admin
 * (administracion.routes.ts). Los administradores (usuarios) viven en el módulo de auth.
 */
@Module({ imports: [AuditoriaModule, ReservaAdminModule, EmbarqueModule] })
export class AdministracionModule {}
