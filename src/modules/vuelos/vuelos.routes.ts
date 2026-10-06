import { Routes } from '@nestjs/core';
import { catalogoRoutes } from './catalogo/catalogo.routes';
import { operacionesRoutes } from './operaciones/operaciones.routes';
import { VuelosModule } from './vuelos.module';

/**
 * Rutas del dominio de vuelos. Cada entidad aporta su <entidad>.routes.ts y se cuelga aquí:
 * el catálogo bajo `admin` y las operaciones con las rutas del contrato (fases 4 a 10).
 */
export const vuelosRoutes: Routes = [
  { path: '/', module: VuelosModule, children: [...catalogoRoutes, ...operacionesRoutes] },
];
