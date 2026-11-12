import { Routes } from '@nestjs/core';
import { busquedaRoutes } from './busqueda/busqueda.routes';
import { cambioFechaRoutes } from './cambio-fecha/cambio-fecha.routes';
import { cancelacionRoutes } from './cancelacion/cancelacion.routes';
import { checkinRoutes } from './checkin/checkin.routes';
import { equipajeRoutes } from './equipaje/equipaje.routes';
import { estadoVueloRoutes } from './estado-vuelo/estado-vuelo.routes';
import { kioskoRoutes } from './kiosko/kiosko.routes';
import { ofertaRoutes } from './oferta/oferta.routes';
import { paseAbordarRoutes } from './pase-abordar/pase-abordar.routes';
import { reservaRoutes } from './reserva/reserva.routes';
import { retencionRoutes } from './retencion/retencion.routes';
import { tableroSalidasRoutes } from './tablero-salidas/tablero-salidas.routes';
import { webhookRoutes } from './webhook/webhook.routes';

/**
 * Las rutas del contrato, cada una con su <entidad>.routes.ts, y las propias de la fase F1
 * (kiosko y salidas públicas), que el contrato no tiene.
 */
export const operacionesRoutes: Routes = [
  ...busquedaRoutes,
  ...retencionRoutes,
  ...ofertaRoutes,
  ...reservaRoutes,
  ...equipajeRoutes,
  ...cancelacionRoutes,
  ...cambioFechaRoutes,
  ...checkinRoutes,
  ...paseAbordarRoutes,
  ...estadoVueloRoutes,
  ...webhookRoutes,
  ...kioskoRoutes,
  ...tableroSalidasRoutes,
];
