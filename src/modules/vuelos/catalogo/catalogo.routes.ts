import { Routes } from '@nestjs/core';
import { CatalogoModule } from './catalogo.module';

/** /flights/v1/admin/<entidad>: cada entidad aporta su <entidad>.routes.ts. */
export const catalogoRoutes: Routes = [{ path: 'admin', module: CatalogoModule, children: [] }];
