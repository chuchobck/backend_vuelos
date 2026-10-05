import { Routes } from '@nestjs/core';
import { aerolineaRoutes } from './aerolinea/aerolinea.routes';
import { aeropuertoRoutes } from './aeropuerto/aeropuerto.routes';
import { CatalogoModule } from './catalogo.module';
import { ciudadRoutes } from './ciudad/ciudad.routes';
import { familiaTarifaRoutes } from './familia-tarifa/familia-tarifa.routes';
import { mapaAsientosRoutes } from './mapa-asientos/mapa-asientos.routes';
import { modeloAeronaveRoutes } from './modelo-aeronave/modelo-aeronave.routes';
import { paisRoutes } from './pais/pais.routes';

/** /flights/v1/admin/<entidad>: cada entidad aporta su <entidad>.routes.ts. */
export const catalogoRoutes: Routes = [
  {
    path: 'admin',
    module: CatalogoModule,
    children: [
      ...paisRoutes,
      ...ciudadRoutes,
      ...aeropuertoRoutes,
      ...aerolineaRoutes,
      ...modeloAeronaveRoutes,
      ...familiaTarifaRoutes,
      ...mapaAsientosRoutes,
    ],
  },
];
