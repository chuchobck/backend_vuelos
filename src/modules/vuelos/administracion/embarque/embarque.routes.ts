import { Routes } from '@nestjs/core';
import { EmbarqueModule } from './embarque.module';

/** Cuelga de la salida del catálogo: /admin/departures/{departureId}/boarding. */
export const embarqueRoutes: Routes = [
  { path: 'departures/:departureId/boarding', module: EmbarqueModule },
];
