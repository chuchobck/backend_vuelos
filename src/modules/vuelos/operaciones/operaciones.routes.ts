import { Routes } from '@nestjs/core';
import { busquedaRoutes } from './busqueda/busqueda.routes';
import { ofertaRoutes } from './oferta/oferta.routes';
import { retencionRoutes } from './retencion/retencion.routes';

/** Las rutas del contrato, cada una con su <entidad>.routes.ts. */
export const operacionesRoutes: Routes = [...busquedaRoutes, ...retencionRoutes, ...ofertaRoutes];
