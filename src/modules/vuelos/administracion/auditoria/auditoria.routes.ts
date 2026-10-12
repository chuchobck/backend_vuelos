import { Routes } from '@nestjs/core';
import { AuditoriaModule } from './auditoria.module';

export const auditoriaRoutes: Routes = [{ path: 'audit-log', module: AuditoriaModule }];
