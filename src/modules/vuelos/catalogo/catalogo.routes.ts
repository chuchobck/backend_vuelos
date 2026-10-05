import { Routes } from '@nestjs/core';
import { aeropuertoRoutes } from './aeropuerto/aeropuerto.routes';
import { CatalogoModule } from './catalogo.module';
import { ciudadRoutes } from './ciudad/ciudad.routes';
import { paisRoutes } from './pais/pais.routes';

/** /flights/v1/admin/<entidad>: cada entidad aporta su <entidad>.routes.ts. */
export const catalogoRoutes: Routes = [
  {
    path: 'admin',
    module: CatalogoModule,
    children: [...paisRoutes, ...ciudadRoutes, ...aeropuertoRoutes],
  },
];
