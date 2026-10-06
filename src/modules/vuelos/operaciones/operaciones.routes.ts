import { Routes } from '@nestjs/core';
import { busquedaRoutes } from './busqueda/busqueda.routes';
import { cancelacionRoutes } from './cancelacion/cancelacion.routes';
import { equipajeRoutes } from './equipaje/equipaje.routes';
import { ofertaRoutes } from './oferta/oferta.routes';
import { reservaRoutes } from './reserva/reserva.routes';
import { retencionRoutes } from './retencion/retencion.routes';

/** Las rutas del contrato, cada una con su <entidad>.routes.ts. */
export const operacionesRoutes: Routes = [
  ...busquedaRoutes,
  ...retencionRoutes,
  ...ofertaRoutes,
  ...reservaRoutes,
  ...equipajeRoutes,
  ...cancelacionRoutes,
];
